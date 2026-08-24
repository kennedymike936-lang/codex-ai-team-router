[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$analyzer = Join-Path $PSScriptRoot "ai-team-evolve.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) "ai-team-evolve-$([guid]::NewGuid().ToString('N'))"
$ledger = Join-Path $fixture "worker-runs.jsonl"
$outRoot = Join-Path $fixture "out"
$auditRoot = Join-Path $fixture "audit"

try {
  New-Item -ItemType Directory -Force -Path $fixture | Out-Null
  @(
    '{"kind":"scout_pack","enabled":false,"reason":"auto skipped for focused inspection","total_tokens":32586}',
    '{"kind":"scout_pack","enabled":false,"reason":"auto skipped for focused inspection","total_tokens":1200}',
    '{"schema_version":"1.0","success":false,"usage_availability":"unavailable","usage_reason":"FatalTurnLimitedError before result event","total_tokens":null}',
    '{"schema_version":"1.0","success":true,"usage_availability":"reported","total_tokens":5000}'
  ) | Set-Content -LiteralPath $ledger -Encoding UTF8

  foreach ($i in 1..6) {
    $taskId = "shadow-$i"
    $taskDir = Join-Path $auditRoot $taskId
    New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
    $provider = $(if ($i -le 3) { "qwen" } else { "deepseek" })
    $tokens = $(if ($i -le 3) { 1000 } else { 3000 })
    Add-Content -LiteralPath $ledger -Value "{`"task_id`":`"$taskId`",`"total_tokens`":$tokens,`"provider_duration_ms`":1000}"
    @{ schema_version="1.0"; task_id=$taskId; selected=@{provider=$provider;id=$provider} } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskDir "route-decision.json") -Encoding UTF8
    $decision = $(if ($i -le 3 -or $i -eq 4) { "accept" } else { "takeover" })
    @{ schema_version="1.0"; task_id=$taskId; last_gate=@{decision=$decision;score=90} } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskDir "checkpoint.json") -Encoding UTF8
  }

  $raw = & $analyzer -UsageLedger $ledger -AuditRoot $auditRoot -OutRoot $outRoot -HighTokenThreshold 20000 -JsonOnly
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
  if (-not $result.shadow_mode.enabled -or $result.shadow_mode.auto_apply -or $result.shadow_mode.joined_run_count -ne 6) {
    throw "Expected a read-only six-run shadow analysis."
  }
  if ($result.shadow_mode.counterfactuals.Count -ne 1 -or $result.shadow_mode.counterfactuals[0].shadow_route -ne "qwen:qwen") {
    throw "Expected shadow mode to prefer the higher-acceptance, lower-token route. Actual: $($result.shadow_mode | ConvertTo-Json -Depth 8 -Compress)"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $outRoot "latest-proposal.json"))) {
    throw "Expected a durable compact proposal artifact."
  }
  if (-not $result.evolution_state.changed_since_last) { throw "Expected the first analysis to report a new signal fingerprint." }
  $secondRaw = & $analyzer -UsageLedger $ledger -AuditRoot $auditRoot -OutRoot $outRoot -HighTokenThreshold 20000 -JsonOnly
  $second = (($secondRaw -join "`n") | ConvertFrom-Json)
  if ($second.evolution_state.changed_since_last -or $second.evolution_state.fingerprint -ne $result.evolution_state.fingerprint) {
    throw "Expected unchanged telemetry to suppress duplicate evolution work."
  }
  Write-Host "AI Team evolution analyzer: 5 scenarios passed"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
