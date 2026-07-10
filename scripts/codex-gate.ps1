[CmdletBinding()]
param(
  [string]$Cwd = (Get-Location).Path,
  [int]$MaxDiffLines = 800,
  [int]$MaxChangedFiles = 25,
  [int]$CommandTimeoutSec = 180,
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\runs")
)

$ErrorActionPreference = "Stop"
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Add-ToolPath {
  $extraDirs = @(
    $env:AI_TEAM_NODE_DIR,
    $env:AI_TEAM_GIT_DIR,
    $env:AI_TEAM_TOOLS_DIR,
    (Join-Path $env:APPDATA "npm")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($extraDirs.Count -gt 0) {
    $env:Path = (($extraDirs + $env:Path) -join ";")
  }
}

function Invoke-Step {
  param([string]$Name, [string]$Command, [string]$WorkDir, [int]$TimeoutSec)

  $job = Start-Job -ScriptBlock {
    param($wd, $cmd)
    Set-Location $wd
    $output = cmd /c $cmd 2>&1 | Out-String
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = $output
    }
  } -ArgumentList $WorkDir, $Command

  $completed = Wait-Job $job -Timeout $TimeoutSec
  if (-not $completed) {
    Stop-Job $job -Force | Out-Null
    Remove-Job $job -Force | Out-Null
    return [pscustomobject]@{
      Name = $Name
      Command = $Command
      Status = "timeout"
      ExitCode = $null
      Output = "Timed out after $TimeoutSec seconds."
    }
  }

  $result = Receive-Job $job
  Remove-Job $job | Out-Null
  $status = "pass"
  if ($result.ExitCode -ne 0) {
    $status = "fail"
  }
  return [pscustomobject]@{
    Name = $Name
    Command = $Command
    Status = $status
    ExitCode = $result.ExitCode
    Output = [string]$result.Output
  }
}

function Get-PackageScripts {
  param([string]$PackageJson)
  if (-not (Test-Path -LiteralPath $PackageJson)) {
    return @{}
  }
  try {
    $pkg = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
    $map = @{}
    if ($pkg.scripts) {
      $pkg.scripts.PSObject.Properties | ForEach-Object { $map[$_.Name] = [string]$_.Value }
    }
    return $map
  } catch {
    return @{}
  }
}

function Has-Script {
  param($Scripts, [string[]]$Names)
  foreach ($name in $Names) {
    if ($Scripts.ContainsKey($name)) {
      return $name
    }
  }
  return $null
}

if (-not (Test-Path -LiteralPath $Cwd)) {
  throw "Cwd does not exist: $Cwd"
}

Add-ToolPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutRoot "$timestamp-gate"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$reportPath = Join-Path $runDir "gate.md"

Push-Location $Cwd
try {
  $isGit = $false
  try {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -eq 0) { $isGit = $true }
  } catch {}

  $changedFiles = @()
  $diffLines = 0
  $dependencyFiles = @()
  $forbiddenFiles = @()
  $secretHits = @()

  $forbiddenPatterns = @(
    ".env",
    ".env.local",
    ".env.production",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519"
  )
  $dependencyPatterns = @(
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "Pipfile",
    "Cargo.toml",
    "Cargo.lock"
  )

  if ($isGit) {
    $changedFiles = @(git diff --name-only)
    $untrackedFiles = @(git ls-files --others --exclude-standard)
    $changedFiles = @($changedFiles + $untrackedFiles | Where-Object { $_ } | Select-Object -Unique)

    $numstat = @(git diff --numstat)
    foreach ($line in $numstat) {
      $parts = $line -split "\s+"
      if ($parts.Count -ge 3) {
        $add = 0
        $del = 0
        [void][int]::TryParse($parts[0], [ref]$add)
        [void][int]::TryParse($parts[1], [ref]$del)
        $diffLines += $add + $del
      }
    }

    foreach ($file in $changedFiles) {
      foreach ($pattern in $forbiddenPatterns) {
        if ($file -like $pattern -or $file -like "*/$pattern") {
          $forbiddenFiles += $file
        }
      }
      foreach ($pattern in $dependencyPatterns) {
        if ($file -like $pattern -or $file -like "*/$pattern") {
          $dependencyFiles += $file
        }
      }
    }

    $diffText = git diff -U0
    $secretPatterns = @(
      "sk-[A-Za-z0-9_-]{20,}",
      "api[_-]?key\s*[:=]",
      "Authorization:\s*Bearer\s+",
      "BEGIN (RSA|OPENSSH|PRIVATE) KEY"
    )
    foreach ($pattern in $secretPatterns) {
      $matches = @($diffText | Select-String -Pattern $pattern -AllMatches)
      foreach ($match in $matches) {
        $secretHits += $match.Line
      }
    }
  }

  $steps = @()
  $packageJson = Join-Path $Cwd "package.json"
  $scripts = Get-PackageScripts -PackageJson $packageJson
  if ($scripts.Count -gt 0) {
    $buildScript = Has-Script -Scripts $scripts -Names @("build", "compile")
    $testScript = Has-Script -Scripts $scripts -Names @("test")
    $typeScript = Has-Script -Scripts $scripts -Names @("typecheck", "type-check", "check-types", "tsc")
    $lintScript = Has-Script -Scripts $scripts -Names @("lint")

    if ($buildScript) {
      $steps += Invoke-Step -Name "code can run/build" -Command "npm run $buildScript" -WorkDir $Cwd -TimeoutSec $CommandTimeoutSec
    }
    if ($testScript) {
      $steps += Invoke-Step -Name "tests" -Command "npm run $testScript" -WorkDir $Cwd -TimeoutSec $CommandTimeoutSec
    }
    if ($typeScript) {
      $steps += Invoke-Step -Name "type check" -Command "npm run $typeScript" -WorkDir $Cwd -TimeoutSec $CommandTimeoutSec
    }
    if ($lintScript) {
      $steps += Invoke-Step -Name "lint" -Command "npm run $lintScript" -WorkDir $Cwd -TimeoutSec $CommandTimeoutSec
    }
  }

  $hardFails = @()
  if (-not $isGit) { $hardFails += "not a git repository, cannot inspect diff safely" }
  if ($forbiddenFiles.Count -gt 0) { $hardFails += "forbidden files changed" }
  if ($secretHits.Count -gt 0) { $hardFails += "possible API key or secret in diff" }
  if ($changedFiles.Count -gt $MaxChangedFiles) { $hardFails += "too many changed files: $($changedFiles.Count)" }
  if ($diffLines -gt $MaxDiffLines) { $hardFails += "diff too large: $diffLines lines" }
  foreach ($step in $steps) {
    if ($step.Status -ne "pass") {
      $hardFails += "$($step.Name) did not pass"
    }
  }

  $lines = @()
  $lines += "# Codex Worker Gate"
  $lines += ""
  if ($hardFails.Count -eq 0) {
    $lines += "Overall: PASS"
  } else {
    $lines += "Overall: CHECK"
  }
  $lines += ""
  $lines += "Workspace: $Cwd"
  $lines += "Git repository: $isGit"
  $lines += "Changed files: $($changedFiles.Count)"
  $lines += "Diff lines: $diffLines"
  $lines += "Dependency files changed: $($dependencyFiles.Count)"
  $lines += "Forbidden files changed: $($forbiddenFiles.Count)"
  $lines += "Secret/API-key hits: $($secretHits.Count)"
  $lines += ""
  $lines += "## Gate Criteria"
  $lines += ""
  $lines += "- Code can run/build: $($(if (($steps | Where-Object Name -eq 'code can run/build').Count -eq 0) { 'not detected' } else { ($steps | Where-Object Name -eq 'code can run/build')[0].Status }))"
  $lines += "- Tests pass: $($(if (($steps | Where-Object Name -eq 'tests').Count -eq 0) { 'not detected' } else { ($steps | Where-Object Name -eq 'tests')[0].Status }))"
  $lines += "- Type check pass: $($(if (($steps | Where-Object Name -eq 'type check').Count -eq 0) { 'not detected' } else { ($steps | Where-Object Name -eq 'type check')[0].Status }))"
  $lines += "- Lint pass: $($(if (($steps | Where-Object Name -eq 'lint').Count -eq 0) { 'not detected' } else { ($steps | Where-Object Name -eq 'lint')[0].Status }))"
  $lines += "- Forbidden files unchanged: $([bool]($forbiddenFiles.Count -eq 0))"
  $lines += "- Diff size acceptable: $([bool]($diffLines -le $MaxDiffLines -and $changedFiles.Count -le $MaxChangedFiles))"
  $lines += "- New dependency files touched: $([bool]($dependencyFiles.Count -gt 0))"
  $lines += "- API key touched: $([bool]($secretHits.Count -gt 0))"
  $lines += ""

  if ($hardFails.Count -gt 0) {
    $lines += "## Items To Check"
    foreach ($fail in $hardFails) {
      $lines += "- $fail"
    }
    $lines += ""
  }

  if ($changedFiles.Count -gt 0) {
    $lines += "## Changed Files"
    foreach ($file in $changedFiles) {
      $lines += "- $file"
    }
    $lines += ""
  }

  if ($dependencyFiles.Count -gt 0) {
    $lines += "## Dependency Files"
    foreach ($file in ($dependencyFiles | Select-Object -Unique)) {
      $lines += "- $file"
    }
    $lines += ""
  }

  if ($forbiddenFiles.Count -gt 0) {
    $lines += "## Forbidden Files"
    foreach ($file in ($forbiddenFiles | Select-Object -Unique)) {
      $lines += "- $file"
    }
    $lines += ""
  }

  foreach ($step in $steps) {
    $lines += "## $($step.Name)"
    $lines += ""
    $lines += ('Command: `{0}`' -f $step.Command)
    $lines += "Status: $($step.Status)"
    $lines += "ExitCode: $($step.ExitCode)"
    $lines += ""
    $lines += '```text'
    $lines += (($step.Output -split "`r?`n") | Select-Object -Last 80)
    $lines += '```'
    $lines += ""
  }

  $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Get-Content -LiteralPath $reportPath -Encoding UTF8
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Gate report: $reportPath"
