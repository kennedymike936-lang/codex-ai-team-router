[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$packScript = Join-Path $PSScriptRoot "codex-scout-pack.ps1"
$scoutScript = Join-Path $PSScriptRoot "codex-scout.ps1"
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "ai-team-scout-pack-$([guid]::NewGuid().ToString('N'))"

function Invoke-Pack {
  param([int]$MaxChars = 10000, [int]$MaxMatches = 30)
  $raw = & $packScript -Task "Inspect mechanicalScoutTarget package tests token" -Cwd $fixture -MaxChars $MaxChars -MaxMatches $MaxMatches -JsonOnly
  return (($raw -join "`n") | ConvertFrom-Json)
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture "src"), (Join-Path $fixture "node_modules"), (Join-Path $fixture "keys") | Out-Null
  '{"name":"scout-fixture","version":"1.0.0","scripts":{"test":"node test.js","build":"node build.js"}}' |
    Set-Content -LiteralPath (Join-Path $fixture "package.json") -Encoding UTF8
  "export const mechanicalScoutTarget = true;" | Set-Content -LiteralPath (Join-Path $fixture "src\router.js") -Encoding UTF8
  'const token = "fixture-sensitive-value-that-must-not-leak";' | Set-Content -LiteralPath (Join-Path $fixture "src\token-config.js") -Encoding UTF8
  "mechanicalScoutTarget`n" * 400 | Set-Content -LiteralPath (Join-Path $fixture "src\large.md") -Encoding UTF8
  1..55 | ForEach-Object {
    "export const mechanicalScoutTarget$_ = true;" | Set-Content -LiteralPath (Join-Path $fixture ("src\mechanicalScoutTarget-{0:D2}.js" -f $_)) -Encoding UTF8
  }
  "IGNORED_VALUE=fixture-sensitive-value-that-must-not-leak" | Set-Content -LiteralPath (Join-Path $fixture ".env") -Encoding UTF8
  "PRIVATE KEY fixture-sensitive-value-that-must-not-leak" | Set-Content -LiteralPath (Join-Path $fixture "keys\fixture.pem") -Encoding UTF8
  '{"fixture":"fixture-sensitive-value-that-must-not-leak"}' | Set-Content -LiteralPath (Join-Path $fixture "secrets.json") -Encoding UTF8
  "mechanicalScoutTarget secret noise" | Set-Content -LiteralPath (Join-Path $fixture "node_modules\noise.js") -Encoding UTF8

  $normal = Invoke-Pack -MaxChars 50000 -MaxMatches 100
  if ($normal.is_git -ne $false -or $normal.content -notmatch "repository: non-git") { throw "Expected non-Git workspace metadata." }
  if ($normal.content -notmatch "scout-fixture" -or $normal.content -notmatch "scripts: build, test") { throw "Expected package identity and scripts." }
  if ($normal.content -notmatch "src[/\\]mechanicalScoutTarget-" -or $normal.content -notmatch "match:.*mechanicalScoutTarget") { throw "Expected relevant file and keyword match." }
  if ($normal.content -match "fixture-sensitive-value" -or $normal.content -match "node_modules" -or $normal.content -match "fixture.pem" -or $normal.content -match "secrets.json" -or $normal.content -match "\.env") { throw "Secret-prone content leaked into the pack." }
  if ($normal.content -notmatch "\[REDACTED\]") {
    $redactionEvidence = @(($normal.content -split "`n") | Where-Object { $_ -match "(?i)token|redacted" } | Select-Object -First 8) -join " | "
    throw "Expected secret-like source values to be redacted. Evidence: $redactionEvidence"
  }

  $small = Invoke-Pack -MaxChars 1000
  if ($small.char_count -gt 1000 -or -not $small.truncated -or $small.content -notmatch "SCOUT PACK TRUNCATED") { throw "Expected a hard length cap with truncation metadata." }

  $scoutText = Get-Content -LiteralPath $scoutScript -Raw -Encoding UTF8
  if ($scoutText -notmatch "codex-scout-pack\.ps1" -or $scoutText -notmatch "do not call any tools" -or $scoutText -notmatch 'kind = "scout_pack"') { throw "Scout integration or ledger wiring is incomplete." }
  if ($scoutText -notmatch '\[string\]\$TaskId' -or $scoutText -notmatch 'TaskId = \$TaskId' -or $scoutText -notmatch '\[int\]\$MaxSessionTurns = 4') { throw "Scout TaskId propagation or safe default turn budget is incomplete." }

  $previousMode = $env:AI_TEAM_SCOUT_PACK
  try {
    Remove-Item Env:AI_TEAM_SCOUT_PACK -ErrorAction SilentlyContinue
    $focusedMode = ((& $scoutScript -Task "Locate the package version" -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if (-not $focusedMode.enabled -or $focusedMode.reason -notmatch "bounded mechanical preflight") { throw "Expected focused inspection to use the bounded Scout Pack in AUTO mode." }

    $broadMode = ((& $scoutScript -Task "Explain the staged architecture workflow across modules" -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if (-not $broadMode.enabled -or $broadMode.reason -notmatch "auto enabled") { throw "Expected broad workflow inspection to enable Scout Pack in AUTO mode." }

    $chineseBroadMode = ((& $scoutScript -Task ([string]([char]0x89e3) + [char]0x91ca + [char]0x8de8 + [char]0x6a21 + [char]0x5757 + [char]0x67b6 + [char]0x6784 + [char]0x548c + [char]0x5de5 + [char]0x4f5c + [char]0x6d41 + [char]0x7a0b) -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if (-not $chineseBroadMode.enabled -or $chineseBroadMode.reason -notmatch "auto enabled") { throw "Expected Chinese broad workflow inspection to enable Scout Pack in AUTO mode." }

    $env:AI_TEAM_SCOUT_PACK = "off"
    $environmentMode = ((& $scoutScript -Task "mode fixture" -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if ($environmentMode.enabled -or $environmentMode.reason -notmatch "environment override") { throw "Expected environment override to disable the pack." }

    $env:AI_TEAM_SCOUT_PACK = "1"
    $environmentOnMode = ((& $scoutScript -Task "mode fixture" -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if (-not $environmentOnMode.enabled -or $environmentOnMode.reason -notmatch "environment override") { throw "Expected environment override to force the pack." }

    $forceMode = ((& $scoutScript -Task "mode fixture" -ForceScoutPack -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if (-not $forceMode.enabled -or $forceMode.reason -notmatch "ForceScoutPack") { throw "Expected explicit force switch to enable the pack." }

    $disableMode = ((& $scoutScript -Task "mode fixture" -DisableScoutPack -ForceScoutPack -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json
    if ($disableMode.enabled -or $disableMode.reason -notmatch "DisableScoutPack") { throw "Expected explicit disable switch to take precedence." }
  } finally {
    if ($null -eq $previousMode) { Remove-Item Env:AI_TEAM_SCOUT_PACK -ErrorAction SilentlyContinue }
    else { $env:AI_TEAM_SCOUT_PACK = $previousMode }
  }

  Write-Host "Mechanical scout pack: 12 scenarios passed"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
