[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "codex-ai-team-gate-$([guid]::NewGuid().ToString('N'))"
$gate = Join-Path $PSScriptRoot "codex-gate.ps1"
$outRoot = "$fixture-runs"

function Invoke-FixtureGate {
  param(
    [int]$Attempt,
    [string]$RequirementStatus,
    [string[]]$AllowedPath = @("src")
  )
  $raw = & $gate `
    -Cwd $fixture `
    -TaskId "fixture" `
    -Task "Verify quality takeover policy" `
    -Attempt $Attempt `
    -RequirementStatus $RequirementStatus `
    -AllowedPath $AllowedPath `
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

  $leakPath = Join-Path $fixture "src\leak.js"
  ('const apiKey = "' + ('x' * 24) + '";') | Set-Content -LiteralPath $leakPath -Encoding UTF8
  $secretFailure = Invoke-FixtureGate -Attempt 1 -RequirementStatus pass
  if ($secretFailure.decision -ne "takeover" -or $secretFailure.checks.secrets -ne "fail") {
    throw "Expected an immediate takeover for secret-like content."
  }
  Remove-Item -LiteralPath $leakPath -Force

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

  Write-Host "PowerShell gate: 6 scenarios passed"
} finally {
  if ((Get-Location).Path -eq $fixture) { Pop-Location }
  if (Test-Path -LiteralPath $fixture) {
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
  if (Test-Path -LiteralPath $outRoot) {
    Remove-Item -LiteralPath $outRoot -Recurse -Force
  }
}
