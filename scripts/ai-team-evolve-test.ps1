[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$analyzer = Join-Path $PSScriptRoot "ai-team-evolve.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) "ai-team-evolve-$([guid]::NewGuid().ToString('N'))"
$ledger = Join-Path $fixture "worker-runs.jsonl"
$outRoot = Join-Path $fixture "out"

try {
  New-Item -ItemType Directory -Force -Path $fixture | Out-Null
  @(
    '{"kind":"scout_pack","enabled":false,"reason":"auto skipped for focused inspection","total_tokens":32586}',
    '{"kind":"scout_pack","enabled":false,"reason":"auto skipped for focused inspection","total_tokens":1200}',
    '{"schema_version":"1.0","success":false,"usage_availability":"unavailable","usage_reason":"FatalTurnLimitedError before result event","total_tokens":null}',
    '{"schema_version":"1.0","success":true,"usage_availability":"reported","total_tokens":5000}'
  ) | Set-Content -LiteralPath $ledger -Encoding UTF8

  $raw = & $analyzer -UsageLedger $ledger -OutRoot $outRoot -HighTokenThreshold 20000 -JsonOnly
  $result = (($raw -join "`n") | ConvertFrom-Json)
  if ($result.mode -ne "read_only_proposal" -or $result.signals.focused_high_token_count -ne 1) {
    throw "Expected one high-token focused inspection signal."
  }
  if ($result.signals.turn_limit_count -ne 1 -or $result.signals.unavailable_usage_count -ne 1) {
    throw "Expected explicit turn-limit and unavailable-usage signals."
  }
  if ($result.permissions.source_write -or $result.permissions.model_call -or $result.permissions.commit -or $result.permissions.deploy -or $result.permissions.push) {
    throw "Evolution analyzer must remain read-only."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $outRoot "latest-proposal.json"))) {
    throw "Expected a durable compact proposal artifact."
  }
  if (-not $result.evolution_state.changed_since_last) { throw "Expected the first analysis to report a new signal fingerprint." }
  $secondRaw = & $analyzer -UsageLedger $ledger -OutRoot $outRoot -HighTokenThreshold 20000 -JsonOnly
  $second = (($secondRaw -join "`n") | ConvertFrom-Json)
  if ($second.evolution_state.changed_since_last -or $second.evolution_state.fingerprint -ne $result.evolution_state.fingerprint) {
    throw "Expected unchanged telemetry to suppress duplicate evolution work."
  }
  Write-Host "AI Team evolution analyzer: 4 scenarios passed"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
