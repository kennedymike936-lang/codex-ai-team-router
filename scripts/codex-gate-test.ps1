[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "codex-ai-team-gate-$([guid]::NewGuid().ToString('N'))"
$gate = Join-Path $PSScriptRoot "codex-gate.ps1"
$outRoot = "$fixture-runs"
$unbornFixture = "$fixture-unborn"

function Invoke-FixtureGate {
  param(
    [int]$Attempt,
    [string]$RequirementStatus,
    [string[]]$AllowedPath = @("src"),
    [string]$WorkerRunDir = "",
    [string]$ChangedPathJson = ""
  )
  $raw = & $gate `
    -Cwd $fixture `
    -TaskId "fixture" `
    -Task "Verify quality takeover policy" `
    -Attempt $Attempt `
    -RequirementStatus $RequirementStatus `
    -AllowedPath $AllowedPath `
    -ChangedPathJson $ChangedPathJson `
    -WorkerRunDir $WorkerRunDir `
    -OutRoot $outRoot `
    -JsonOnly
  return (($raw -join "`n") | ConvertFrom-Json)
}

function Assert-Decision {
  param($Result, [string]$Expected, [int]$ExpectedScore)
  if ($Result.decision -ne $Expected -or $Result.score -ne $ExpectedScore) {
    throw "Expected $Expected/$ExpectedScore, got $($Result.decision)/$($Result.score)."
  }
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture "src") | Out-Null
  Push-Location $fixture
  git init -q
  git config user.name "AI Team Test"
  git config user.email "ai-team-test@example.invalid"
  "fixture" | Set-Content -LiteralPath "README.md" -Encoding UTF8
  git add README.md
  git commit -q -m "fixture"
  "export const ready = true;" | Set-Content -LiteralPath "src\app.js" -Encoding UTF8
  Pop-Location

  Assert-Decision (Invoke-FixtureGate -Attempt 1 -RequirementStatus pass) "accept" 95
  Assert-Decision (Invoke-FixtureGate -Attempt 1 -RequirementStatus unknown) "retry" 85
  Assert-Decision (Invoke-FixtureGate -Attempt 2 -RequirementStatus unknown) "takeover" 85

  $gamePath = Join-Path $fixture "src\game.html"
  '<!doctype html><canvas id="game"></canvas><script>const ready = true;</script>' | Set-Content -LiteralPath $gamePath -Encoding UTF8
  $validHtml = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
  if ($validHtml.decision -ne "accept" -or $validHtml.checks.html_smoke -ne "pass") {
    throw "Expected valid inline HTML script to pass the smoke check."
  }

  '<!doctype html><canvas id="game"></canvas><script>const broken = ;</script>' | Set-Content -LiteralPath $gamePath -Encoding UTF8
  $invalidHtml = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
  if ($invalidHtml.decision -ne "takeover" -or $invalidHtml.checks.html_smoke -ne "fail") {
    throw "Expected invalid inline JavaScript to trigger takeover."
  }
  Remove-Item -LiteralPath $gamePath -Force

  $leakPath = Join-Path $fixture "src\leak.js"
  ('const apiKey = "' + ('x' * 24) + '";') | Set-Content -LiteralPath $leakPath -Encoding UTF8
  $secretFailure = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass
  if ($secretFailure.decision -ne "takeover" -or $secretFailure.checks.secrets -ne "fail") {
    throw "Expected an immediate takeover for secret-like content."
  }
  Remove-Item -LiteralPath $leakPath -Force

  $workerRun = Join-Path $outRoot "worker-scope-fixture"
  New-Item -ItemType Directory -Force -Path $workerRun, (Join-Path $fixture "docs") | Out-Null
  '{"changed_files":["src/app.js"]}' | Set-Content -LiteralPath (Join-Path $workerRun "worker-result.json") -Encoding UTF8
  "pre-existing user change" | Set-Content -LiteralPath (Join-Path $fixture "docs\preexisting.md") -Encoding UTF8
  $workerScoped = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -AllowedPath @("src") -WorkerRunDir $workerRun
  if ($workerScoped.decision -ne "accept" -or $workerScoped.changed_files.Count -ne 1 -or $workerScoped.changed_files[0] -ne "src/app.js") {
    throw "Expected Gate to evaluate only files changed by the worker."
  }
  Remove-Item -LiteralPath (Join-Path $fixture "docs") -Recurse -Force

  $scopeFailure = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -AllowedPath @("docs")
  if ($scopeFailure.decision -ne "takeover" -or $scopeFailure.hard_failures.Count -eq 0) {
    throw "Expected an immediate takeover for an out-of-scope change."
  }

  Push-Location $fixture
  try {
    $relativeRaw = & $gate -Cwd "." -TaskId "relative" -Attempt 1 -RequirementStatus pass -AllowedPath @("src") -OutRoot $outRoot -JsonOnly
    $relative = ($relativeRaw -join "`n") | ConvertFrom-Json
    Assert-Decision $relative "accept" 95
  } finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $unbornFixture "src") | Out-Null
  Push-Location $unbornFixture
  try {
    git init -q
    git config user.name "AI Team Test"
    git config user.email "ai-team-test@example.invalid"
    "export const staged = true;" | Set-Content -LiteralPath "src\staged.js" -Encoding UTF8
    git add "src\staged.js"
    "export const untracked = true;" | Set-Content -LiteralPath "src\untracked.js" -Encoding UTF8
    $unbornRaw = & $gate -Cwd "." -TaskId "unborn" -Attempt 1 -RequirementStatus pass -AllowedPath @("src") -OutRoot $outRoot -JsonOnly
    $unborn = ($unbornRaw -join "`n") | ConvertFrom-Json
    Assert-Decision $unborn "accept" 95
    if ($unborn.metrics.git_baseline -ne "unborn" -or $unborn.changed_files.Count -ne 2) {
      throw "Expected unborn baseline with two changed files."
    }
  } finally {
    Pop-Location
  }

  Write-Host "PowerShell gate: 10 scenarios passed"
} finally {
  if ((Get-Location).Path -eq $fixture) { Pop-Location }
  if (Test-Path -LiteralPath $fixture) {
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
  if (Test-Path -LiteralPath $outRoot) {
    Remove-Item -LiteralPath $outRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $unbornFixture) {
    Remove-Item -LiteralPath $unbornFixture -Recurse -Force
  }
}
