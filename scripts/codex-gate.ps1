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
  [string]$AllowedPathJson = "",
  [string]$ChangedPathJson = "",
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
  if ((";$env:PATHEXT;") -notmatch ";\.EXE;") {
    $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.CPL"
  }
  $portableGitDirs = @()
  $portableGitRoot = Join-Path $env:LOCALAPPDATA "Programs\PortableGit"
  if (Test-Path -LiteralPath $portableGitRoot) {
    $portableGitDirs = @(Get-ChildItem -LiteralPath $portableGitRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "cmd" })
  }
  $extraDirs = @(
    $env:AI_TEAM_NODE_DIR,
    $env:AI_TEAM_GIT_DIR,
    $env:AI_TEAM_TOOLS_DIR,
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"),
    (Join-Path $env:ProgramFiles "Git\cmd"),
    (Join-Path $env:APPDATA "npm")
  )
  $extraDirs += @($portableGitDirs)
  $extraDirs = @($extraDirs | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if ($extraDirs.Count -gt 0) {
    $env:Path = ((@($extraDirs) + @($env:Path)) -join ";")
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

function Invoke-HtmlSmoke {
  param([string[]]$Files, [string]$Root)

  $htmlFiles = @($Files | Where-Object { $_ -match "(?i)\.html?$" })
  if ($htmlFiles.Count -eq 0) { return $null }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    return [pscustomobject]@{
      Name = "html smoke"
      Command = "node --check <inline scripts>"
      Status = "fail"
      ExitCode = 1
      Output = "Node.js is required to validate changed HTML files."
    }
  }

  $issues = @()
  foreach ($file in $htmlFiles) {
    $absoluteFile = Join-Path $Root $file
    if (-not (Test-Path -LiteralPath $absoluteFile -PathType Leaf)) { continue }
    try {
      $content = [System.IO.File]::ReadAllText($absoluteFile)
    } catch {
      $issues += "$file`: could not read file"
      continue
    }
    if ([string]::IsNullOrWhiteSpace($content)) {
      $issues += "$file`: file is empty"
      continue
    }

    $openScripts = [regex]::Matches($content, "(?is)<script\b[^>]*>").Count
    $closeScripts = [regex]::Matches($content, "(?is)</script\s*>").Count
    if ($openScripts -ne $closeScripts) {
      $issues += "$file`: unbalanced script tags ($openScripts opening, $closeScripts closing)"
      continue
    }
    $openCanvas = [regex]::Matches($content, "(?is)<canvas\b[^>]*>").Count
    $closeCanvas = [regex]::Matches($content, "(?is)</canvas\s*>").Count
    if ($openCanvas -ne $closeCanvas) {
      $issues += "$file`: unbalanced canvas tags ($openCanvas opening, $closeCanvas closing)"
    }

    $scripts = [regex]::Matches($content, "(?is)<script\b(?<attrs>[^>]*)>(?<body>.*?)</script\s*>")
    $scriptNumber = 0
    foreach ($script in $scripts) {
      $scriptNumber += 1
      $attrs = [string]$script.Groups["attrs"].Value
      $body = [string]$script.Groups["body"].Value
      if ($attrs -match "(?i)\bsrc\s*=" -or [string]::IsNullOrWhiteSpace($body)) { continue }

      $typeMatch = [regex]::Match($attrs, '(?i)\btype\s*=\s*["''](?<type>[^"'']+)["'']')
      $scriptType = $(if ($typeMatch.Success) { $typeMatch.Groups["type"].Value.ToLowerInvariant() } else { "text/javascript" })
      if ($scriptType -notmatch "javascript|ecmascript|module") { continue }

      $extension = $(if ($scriptType -eq "module") { ".mjs" } else { ".js" })
      $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) "ai-team-html-$([guid]::NewGuid().ToString('N'))$extension"
      try {
        [System.IO.File]::WriteAllText($tempPath, $body, (New-Object System.Text.UTF8Encoding($false)))
        $previousErrorAction = $ErrorActionPreference
        try {
          $ErrorActionPreference = "Continue"
          $syntaxOutput = & $node.Source --check $tempPath 2>&1 | Out-String
          $syntaxExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousErrorAction
        }
        if ($syntaxExitCode -ne 0) {
          $cleanOutput = $syntaxOutput.Replace($tempPath, $file).Trim()
          $issues += "$file script $scriptNumber`: $cleanOutput"
        }
      } finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
      }
    }
  }

  return [pscustomobject]@{
    Name = "html smoke"
    Command = "node --check <inline scripts>"
    Status = $(if ($issues.Count -eq 0) { "pass" } else { "fail" })
    ExitCode = $(if ($issues.Count -eq 0) { 0 } else { 1 })
    Output = ($issues -join "`n")
  }
}

if (-not (Test-Path -LiteralPath $Cwd)) {
  throw "Cwd does not exist: $Cwd"
}
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path
if (-not [string]::IsNullOrWhiteSpace($AllowedPathJson)) {
  $AllowedPath = @($AllowedPathJson | ConvertFrom-Json | ForEach-Object { [string]$_ })
}
$hasExplicitChangeSet = -not [string]::IsNullOrWhiteSpace($ChangedPathJson)
$explicitChangedFiles = @()
if ($hasExplicitChangeSet) {
  $explicitChangedFiles = @($ChangedPathJson | ConvertFrom-Json | ForEach-Object { [string]$_ } | Where-Object { $_ })
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
  $hasHead = $false
  $gitBaseline = "none"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "SilentlyContinue"
    git rev-parse --is-inside-work-tree *> $null
    $insideGitExit = $LASTEXITCODE
    if ($insideGitExit -eq 0) {
      $isGit = $true
      git rev-parse --verify HEAD *> $null
      $headExit = $LASTEXITCODE
      if ($headExit -eq 0) {
        $hasHead = $true
        $gitBaseline = "head"
      } else {
        $gitBaseline = "unborn"
      }
    }
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  $effectiveMaxDiffLines = $(if ($gitBaseline -eq "unborn") { [math]::Max($MaxDiffLines, 4000) } else { $MaxDiffLines })
  $effectiveMaxChangedFiles = $(if ($gitBaseline -eq "unborn") { [math]::Max($MaxChangedFiles, 80) } else { $MaxChangedFiles })

  $changedFiles = @()
  $diffLines = 0
  $dependencyFiles = @()
  $forbiddenFiles = @()
  $secretHits = @()
  $scopeViolations = @()
  $workerChangedFiles = @()
  $hasWorkerChangeSet = $false

  if ($hasExplicitChangeSet) {
    $workerChangedFiles = @($explicitChangedFiles)
    $hasWorkerChangeSet = $true
  } elseif (-not [string]::IsNullOrWhiteSpace($WorkerRunDir)) {
    $workerResultFile = Join-Path $WorkerRunDir "worker-result.json"
    if (Test-Path -LiteralPath $workerResultFile) {
      try {
        $workerResultData = Get-Content -LiteralPath $workerResultFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $workerResultData.changed_files) {
          $workerChangedFiles = @($workerResultData.changed_files | ForEach-Object { [string]$_ } | Where-Object { $_ })
          $hasWorkerChangeSet = $true
        }
      } catch {}
    }
  }

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
    if ($hasHead) {
      $trackedChangedFiles = @(git diff HEAD --name-only)
    } else {
      $trackedChangedFiles = @(git ls-files --cached)
    }
    $allUntrackedFiles = @(git ls-files --others --exclude-standard)

    if ($hasWorkerChangeSet) {
      $changedFiles = @($workerChangedFiles | Select-Object -Unique)
      $untrackedFiles = @($allUntrackedFiles | Where-Object { $changedFiles -contains $_ })
    } else {
      $changedFiles = @($trackedChangedFiles + $allUntrackedFiles | Where-Object { $_ } | Select-Object -Unique)
      $untrackedFiles = $allUntrackedFiles
    }

    if ($changedFiles.Count -gt 0) {
      if ($hasHead) {
        $numstat = @(git diff HEAD --numstat -- $changedFiles)
        $diffText = git diff HEAD -U0 -- $changedFiles
      } else {
        $numstat = @(git diff --cached --numstat -- $changedFiles)
        $diffText = git diff --cached -U0 -- $changedFiles
      }
    } else {
      $numstat = @()
      $diffText = @()
    }

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

    foreach ($file in $untrackedFiles) {
      $absoluteFile = Join-Path $Cwd $file
      if ((Test-Path -LiteralPath $absoluteFile -PathType Leaf) -and (Get-Item -LiteralPath $absoluteFile).Length -le 1MB) {
        try {
          $diffLines += (Get-Content -LiteralPath $absoluteFile -ErrorAction Stop | Measure-Object -Line).Lines
        } catch {}
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

    $secretPatterns = @(
      "sk-[A-Za-z0-9_-]{20,}",
      '(?i)api[_-]?key\s*[:=]\s*[''"]?[^''"\s]{16,}',
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

  $htmlSmoke = Invoke-HtmlSmoke -Files $changedFiles -Root $Cwd
  if ($null -ne $htmlSmoke) {
    $steps += $htmlSmoke
  }

  $hardFails = @()
  if (-not $isGit) { $hardFails += "not a git repository, cannot inspect diff safely" }
  if ($forbiddenFiles.Count -gt 0) { $hardFails += "forbidden files changed" }
  if ($secretHits.Count -gt 0) { $hardFails += "possible API key or secret in diff" }
  if ($scopeViolations.Count -gt 0) { $hardFails += "files changed outside allowed paths" }
  if ($changedFiles.Count -gt $effectiveMaxChangedFiles) { $hardFails += "too many changed files: $($changedFiles.Count)" }
  if ($diffLines -gt $effectiveMaxDiffLines) { $hardFails += "diff too large: $diffLines lines" }
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
  if ($diffLines -gt [math]::Floor($effectiveMaxDiffLines * 0.75)) { $score -= 5 }
  if ($changedFiles.Count -gt [math]::Floor($effectiveMaxChangedFiles * 0.75)) { $score -= 5 }
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
      html_smoke = Get-StepStatus "html smoke"
      scope = $(if ($scopeViolations.Count -eq 0) { "pass" } else { "fail" })
      secrets = $(if ($secretHits.Count -eq 0) { "pass" } else { "fail" })
      diff_size = $(if ($diffLines -le $effectiveMaxDiffLines -and $changedFiles.Count -le $effectiveMaxChangedFiles) { "pass" } else { "fail" })
    }
    changed_files = @($changedFiles)
    scope_violations = @($scopeViolations)
    dependency_files = @($dependencyFiles | Select-Object -Unique)
    metrics = [ordered]@{
      changed_files = $changedFiles.Count
      diff_lines = $diffLines
      git_baseline = $gitBaseline
      max_changed_files = $effectiveMaxChangedFiles
      max_diff_lines = $effectiveMaxDiffLines
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
  $lines += "Git baseline: $gitBaseline"
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
  $lines += "- HTML smoke pass: $($(if (($steps | Where-Object Name -eq 'html smoke').Count -eq 0) { 'not detected' } else { ($steps | Where-Object Name -eq 'html smoke')[0].Status }))"
  $lines += "- Forbidden files unchanged: $([bool]($forbiddenFiles.Count -eq 0))"
  $lines += "- Diff size acceptable: $([bool]($diffLines -le $effectiveMaxDiffLines -and $changedFiles.Count -le $effectiveMaxChangedFiles))"
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
