[CmdletBinding()]
param(
  [string]$Cwd = (Get-Location).Path,
  [string]$TaskId = "",
  [string]$Task = "",
  [ValidateRange(1, 2)]
  [int]$Attempt = 1,
  [ValidateSet("pass", "partial", "unknown", "fail")]
  [string]$RequirementStatus = "pass",
  [string[]]$AllowedPath = @(),
  [string]$WorkerRunDir = "",
  [int]$MaxDiffLines = 800,
  [int]$MaxChangedFiles = 25,
  [int]$CommandTimeoutSec = 180,
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\runs"),
  [switch]$JsonOnly
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

function Test-PathAllowed {
  param([string]$File, [string[]]$Roots)
  if ($Roots.Count -eq 0) { return $true }
  $normalizedFile = $File.Replace("\", "/").TrimStart("./")
  foreach ($root in $Roots) {
    $normalizedRoot = $root.Replace("\", "/").Trim("/").TrimStart("./")
    if ($normalizedFile -eq $normalizedRoot -or $normalizedFile.StartsWith("$normalizedRoot/", [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

if (-not (Test-Path -LiteralPath $Cwd)) {
  throw "Cwd does not exist: $Cwd"
}

Add-ToolPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutRoot "$timestamp-gate"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$reportPath = Join-Path $runDir "gate.md"
$handoffPath = Join-Path $runDir "handoff.json"
if ([string]::IsNullOrWhiteSpace($TaskId)) {
  $TaskId = "task-$timestamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
}

Push-Location $Cwd
try {
  $isGit = $false
  try {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -eq 0) {
      git rev-parse --verify HEAD *> $null
      if ($LASTEXITCODE -eq 0) { $isGit = $true }
    }
  } catch {}

  $changedFiles = @()
  $diffLines = 0
  $dependencyFiles = @()
  $forbiddenFiles = @()
  $secretHits = @()
  $scopeViolations = @()

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
    $changedFiles = @(git diff HEAD --name-only)
    $untrackedFiles = @(git ls-files --others --exclude-standard)
    $changedFiles = @($changedFiles + $untrackedFiles | Where-Object { $_ } | Select-Object -Unique)

    $numstat = @(git diff HEAD --numstat)
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
      if (-not (Test-PathAllowed -File $file -Roots $AllowedPath)) {
        $scopeViolations += $file
      }
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

    $diffText = git diff HEAD -U0
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

    foreach ($file in $untrackedFiles) {
      $absoluteFile = Join-Path $Cwd $file
      if ((Test-Path -LiteralPath $absoluteFile -PathType Leaf) -and (Get-Item -LiteralPath $absoluteFile).Length -le 1MB) {
        foreach ($pattern in $secretPatterns) {
          if (Select-String -LiteralPath $absoluteFile -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
            $secretHits += "secret-like content in untracked file: $file"
            break
          }
        }
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
  if ($scopeViolations.Count -gt 0) { $hardFails += "files changed outside allowed paths" }
  if ($changedFiles.Count -gt $MaxChangedFiles) { $hardFails += "too many changed files: $($changedFiles.Count)" }
  if ($diffLines -gt $MaxDiffLines) { $hardFails += "diff too large: $diffLines lines" }
  if ($RequirementStatus -eq "fail") { $hardFails += "worker did not satisfy the requested outcome" }
  foreach ($step in $steps) {
    if ($step.Status -ne "pass") {
      $hardFails += "$($step.Name) did not pass"
    }
  }

  $score = 95
  if ($RequirementStatus -eq "unknown") { $score -= 10 }
  if ($RequirementStatus -eq "partial") { $score -= 15 }
  if ($dependencyFiles.Count -gt 0) { $score -= 5 }
  if ($diffLines -gt [math]::Floor($MaxDiffLines * 0.75)) { $score -= 5 }
  if ($changedFiles.Count -gt [math]::Floor($MaxChangedFiles * 0.75)) { $score -= 5 }
  if ($hardFails.Count -gt 0) { $score = [math]::Min($score, 70) }
  $score = [math]::Max(0, $score)

  $decision = "accept"
  $decisionReason = "Quality target reached; further polishing is optional."
  if ($hardFails.Count -gt 0) {
    $decision = "takeover"
    $decisionReason = "A hard gate failed; Codex should take control immediately."
  } elseif ($score -lt 80) {
    $decision = "takeover"
    $decisionReason = "Quality is below the worker recovery threshold."
  } elseif ($score -lt 90 -and $Attempt -ge 2) {
    $decision = "takeover"
    $decisionReason = "The single targeted retry was already used."
  } elseif ($score -lt 90) {
    $decision = "retry"
    $decisionReason = "One targeted worker retry is allowed before Codex takes over."
  }

  function Get-StepStatus([string]$Name) {
    $matched = @($steps | Where-Object Name -eq $Name)
    if ($matched.Count -eq 0) { return "not_detected" }
    return [string]$matched[0].Status
  }

  $handoff = [ordered]@{
    schema_version = "1.0"
    task_id = $TaskId
    task = $Task
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    attempt = $Attempt
    decision = $decision
    score = $score
    reason = $decisionReason
    hard_failures = @($hardFails)
    requirement_status = $RequirementStatus
    checks = [ordered]@{
      build = Get-StepStatus "code can run/build"
      tests = Get-StepStatus "tests"
      typecheck = Get-StepStatus "type check"
      lint = Get-StepStatus "lint"
      scope = $(if ($scopeViolations.Count -eq 0) { "pass" } else { "fail" })
      secrets = $(if ($secretHits.Count -eq 0) { "pass" } else { "fail" })
      diff_size = $(if ($diffLines -le $MaxDiffLines -and $changedFiles.Count -le $MaxChangedFiles) { "pass" } else { "fail" })
    }
    changed_files = @($changedFiles)
    scope_violations = @($scopeViolations)
    dependency_files = @($dependencyFiles | Select-Object -Unique)
    metrics = [ordered]@{
      changed_files = $changedFiles.Count
      diff_lines = $diffLines
      max_changed_files = $MaxChangedFiles
      max_diff_lines = $MaxDiffLines
    }
    artifacts = [ordered]@{
      gate_report = $reportPath
      handoff = $handoffPath
      worker_run = $WorkerRunDir
    }
    retry = [ordered]@{
      allowed = ($decision -eq "retry")
      remaining = $(if ($decision -eq "retry") { 1 } else { 0 })
      instruction = $(if ($decision -eq "retry") { "Fix only failed or incomplete checks, keep the diff bounded, then run the gate with Attempt=2." } else { "" })
    }
    codex_takeover = [ordered]@{
      required = ($decision -eq "takeover")
      instruction = $(if ($decision -eq "takeover") { "Read this handoff and referenced artifacts, restore a working deliverable first, then diagnose the worker failure." } else { "" })
    }
  }
  $handoff | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $handoffPath -Encoding UTF8

  $lines = @()
  $lines += "# Codex Worker Gate"
  $lines += ""
  $lines += "Decision: $($decision.ToUpperInvariant())"
  $lines += "Quality score: $score / 100"
  $lines += "Reason: $decisionReason"
  $lines += ""
  $lines += "Task ID: $TaskId"
  $lines += "Attempt: $Attempt / 2"
  $lines += "Requirement status: $RequirementStatus"
  $lines += "Workspace: $Cwd"
  $lines += "Git repository: $isGit"
  $lines += "Changed files: $($changedFiles.Count)"
  $lines += "Diff lines: $diffLines"
  $lines += "Dependency files changed: $($dependencyFiles.Count)"
  $lines += "Forbidden files changed: $($forbiddenFiles.Count)"
  $lines += "Secret/API-key hits: $($secretHits.Count)"
  $lines += "Scope violations: $($scopeViolations.Count)"
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

  if ($scopeViolations.Count -gt 0) {
    $lines += "## Scope Violations"
    foreach ($file in ($scopeViolations | Select-Object -Unique)) {
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
  if ($JsonOnly) {
    Get-Content -LiteralPath $handoffPath -Raw -Encoding UTF8
  } else {
    Get-Content -LiteralPath $reportPath -Encoding UTF8
  }
} finally {
  Pop-Location
}

if (-not $JsonOnly) {
  Write-Host ""
  Write-Host "Gate report: $reportPath"
  Write-Host "Handoff: $handoffPath"
}
