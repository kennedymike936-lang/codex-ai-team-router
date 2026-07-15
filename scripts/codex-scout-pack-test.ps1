[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$packScript = Join-Path $PSScriptRoot "codex-scout-pack.ps1"
$scoutScript = Join-Path $PSScriptRoot "codex-scout.ps1"
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "ai-team-scout-pack-$([guid]::NewGuid().ToString('N'))"

function Invoke-Pack {
  param([int]$MaxChars = 10000)
  $raw = & $packScript -Task "Inspect mechanicalScoutTarget package tests token" -Cwd $fixture -MaxChars $MaxChars -JsonOnly
  return (($raw -join "`n") | ConvertFrom-Json)
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture "src"), (Join-Path $fixture "node_modules"), (Join-Path $fixture "keys") | Out-Null
  '{"name":"scout-fixture","version":"1.0.0","scripts":{"test":"node test.js","build":"node build.js"}}' |
    Set-Content -LiteralPath (Join-Path $fixture "package.json") -Encoding UTF8
  "export const mechanicalScoutTarget = true;" | Set-Content -LiteralPath (Join-Path $fixture "src\router.js") -Encoding UTF8
  'const token = "fixture-sensitive-value-that-must-not-leak";' | Set-Content -LiteralPath (Join-Path $fixture "src\config.js") -Encoding UTF8
  "mechanicalScoutTarget`n" * 400 | Set-Content -LiteralPath (Join-Path $fixture "src\large.md") -Encoding UTF8
  1..55 | ForEach-Object {
    "export const mechanicalScoutTarget$_ = true;" | Set-Content -LiteralPath (Join-Path $fixture ("src\mechanicalScoutTarget-{0:D2}.js" -f $_)) -Encoding UTF8
  }
  "IGNORED_VALUE=fixture-sensitive-value-that-must-not-leak" | Set-Content -LiteralPath (Join-Path $fixture ".env") -Encoding UTF8
  "PRIVATE KEY fixture-sensitive-value-that-must-not-leak" | Set-Content -LiteralPath (Join-Path $fixture "keys\fixture.pem") -Encoding UTF8
  '{"fixture":"fixture-sensitive-value-that-must-not-leak"}' | Set-Content -LiteralPath (Join-Path $fixture "secrets.json") -Encoding UTF8
  "mechanicalScoutTarget secret noise" | Set-Content -LiteralPath (Join-Path $fixture "node_modules\noise.js") -Encoding UTF8

  $normal = Invoke-Pack
  if ($normal.is_git -ne $false -or $normal.content -notmatch "repository: non-git") { throw "Expected non-Git workspace metadata." }
  if ($normal.content -notmatch "scout-fixture" -or $normal.content -notmatch "scripts: build, test") { throw "Expected package identity and scripts." }
  if ($normal.content -notmatch "src[/\\]mechanicalScoutTarget-" -or $normal.content -notmatch "match:.*mechanicalScoutTarget") { throw "Expected relevant file and keyword match." }
  if ($normal.content -match "fixture-sensitive-value" -or $normal.content -match "node_modules" -or $normal.content -match "fixture.pem" -or $normal.content -match "secrets.json" -or $normal.content -match "\.env") { throw "Secret-prone content leaked into the pack." }
  if ($normal.content -notmatch "\[REDACTED\]") { throw "Expected secret-like source values to be redacted." }

  $small = Invoke-Pack -MaxChars 1000
  if ($small.char_count -gt 1000 -or -not $small.truncated -or $small.content -notmatch "SCOUT PACK TRUNCATED") { throw "Expected a hard length cap with truncation metadata." }

  $scoutText = Get-Content -LiteralPath $scoutScript -Raw -Encoding UTF8
  if ($scoutText -notmatch "codex-scout-pack\.ps1" -or $scoutText -notmatch "do not call any tools" -or $scoutText -notmatch "scout_pack") { throw "Scout integration wiring is incomplete." }

  Write-Host "Mechanical scout pack: 5 scenarios passed"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
