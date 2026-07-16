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
    [string]$AllowedPathJson = "",
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
    -AllowedPathJson $AllowedPathJson `
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

  "export const extra = true;" | Set-Content -LiteralPath (Join-Path $fixture "src\extra.js") -Encoding UTF8
  $jsonArrays = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass `
    -AllowedPathJson '["src/app.js","src/extra.js"]' `
    -ChangedPathJson '["src/app.js","src/extra.js"]'
  if ($jsonArrays.decision -ne "accept" -or $jsonArrays.changed_files.Count -ne 2) {
    throw "Expected JSON path arrays to preserve two distinct entries."
  }
  Remove-Item -LiteralPath (Join-Path $fixture "src\extra.js") -Force

  $gamePath = Join-Path $fixture "src\game.html"
  '<!doctype html><canvas id="game"></canvas><script>const ready = true;</script>' | Set-Content -LiteralPath $gamePath -Encoding UTF8
  $validHtml = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
  if ($validHtml.decision -ne "accept" -or $validHtml.checks.html_smoke -ne "pass" -or $validHtml.checks.browser_smoke -notin @("pass", "not_detected")) {
    throw "Expected valid inline HTML and browser smoke checks to pass or safely report unavailable browser."
  }
  $browserDetected = $validHtml.checks.browser_smoke -eq "pass"

  '<!doctype html><canvas id="game"></canvas><script>setTimeout(() => { throw new Error("runtime fixture"); }, 0);</script>' | Set-Content -LiteralPath $gamePath -Encoding UTF8
  $runtimeHtml = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
  if ($browserDetected) {
    if ($runtimeHtml.decision -ne "takeover" -or $runtimeHtml.checks.html_smoke -ne "pass" -or $runtimeHtml.checks.browser_smoke -ne "fail") {
      throw "Expected a real-browser runtime error to trigger takeover."
    }
  } elseif ($runtimeHtml.decision -ne "accept" -or $runtimeHtml.checks.browser_smoke -ne "not_detected") {
    throw "Expected runtime smoke to degrade safely when no browser is installed."
  }

  '<!doctype html><main>ordinary HTML</main><script>document.body.dataset.ready = "true";</script>' | Set-Content -LiteralPath $gamePath -Encoding UTF8
  $nonCanvasHtml = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
  if ($nonCanvasHtml.decision -ne "accept" -or $nonCanvasHtml.checks.html_smoke -ne "pass" -or $nonCanvasHtml.checks.browser_smoke -notin @("pass", "not_detected")) {
    throw "Expected non-Canvas HTML without runtime errors to pass."
  }

  $previousBrowserMode = $env:AI_TEAM_BROWSER_SMOKE
  try {
    $env:AI_TEAM_BROWSER_SMOKE = "off"
    $unavailableBrowser = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass -ChangedPathJson '["src/game.html"]'
    if ($unavailableBrowser.decision -ne "accept" -or $unavailableBrowser.checks.browser_smoke -ne "not_detected") {
      throw "Expected unavailable-browser mode to be non-fatal and explicitly reported."
    }
  } finally {
    if ($null -eq $previousBrowserMode) { Remove-Item Env:AI_TEAM_BROWSER_SMOKE -ErrorAction SilentlyContinue }
    else { $env:AI_TEAM_BROWSER_SMOKE = $previousBrowserMode }
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

  Write-Host "PowerShell gate: 14 scenarios passed"
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
