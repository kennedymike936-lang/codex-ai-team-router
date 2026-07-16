[CmdletBinding()]
param(
  [string]$UsageLedger = (Join-Path $env:USERPROFILE ".codex-ai-team\usage\worker-runs.jsonl"),
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\evolution"),
  [ValidateRange(10, 5000)]
  [int]$Lookback = 500,
  [ValidateRange(1000, 1000000)]
  [long]$HighTokenThreshold = 20000,
  [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"

function Get-Median([long[]]$Values) {
  $sorted = @($Values | Sort-Object)
  if ($sorted.Count -eq 0) { return 0 }
  $middle = [math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 1) { return [long]$sorted[$middle] }
  return [long](($sorted[$middle - 1] + $sorted[$middle]) / 2)
}

$events = @()
if (Test-Path -LiteralPath $UsageLedger) {
  foreach ($line in @(Get-Content -LiteralPath $UsageLedger -Tail $Lookback -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $events += ($line | ConvertFrom-Json) } catch {}
  }
}

$focusedHigh = @($events | Where-Object {
  $_.kind -eq "scout_pack" -and
  $_.enabled -eq $false -and
  [string]$_.reason -match "auto skipped" -and
  $null -ne $_.total_tokens -and
  [long]$_.total_tokens -ge $HighTokenThreshold
})
$unavailable = @($events | Where-Object {
  $_.usage_availability -eq "unavailable" -or
  ($_.success -eq $false -and $null -eq $_.total_tokens)
})
$turnLimited = @($events | Where-Object {
  [string]$_.usage_reason -match "FatalTurnLimitedError|turn limit|max session turns"
})
$tokenValues = @($focusedHigh | ForEach-Object { [long]$_.total_tokens })

$recommendations = @()
if ($focusedHigh.Count -gt 0) {
  $recommendations += [ordered]@{
    priority = "high"
    id = "expand-safe-mechanical-inspection"
    evidence = "$($focusedHigh.Count) focused inspections exceeded $HighTokenThreshold tokens"
    guardrail = "Add only deterministic, narrow rules with false-positive tests."
  }
}
if ($turnLimited.Count -gt 0) {
  $recommendations += [ordered]@{
    priority = "high"
    id = "reduce-turn-limit-failures"
    evidence = "$($turnLimited.Count) ledger events explicitly reported a turn limit"
    guardrail = "Keep a hard deadline and one targeted retry; do not raise turns globally."
  }
}
if ($unavailable.Count -gt 0) {
  $recommendations += [ordered]@{
    priority = "medium"
    id = "improve-failure-usage-recovery"
    evidence = "$($unavailable.Count) failed events had unavailable usage"
    guardrail = "Recover only provider-reported values; never estimate missing tokens as zero."
  }
}
if ($recommendations.Count -eq 0) {
  $recommendations += [ordered]@{
    priority = "observe"
    id = "collect-more-telemetry"
    evidence = "No configured threshold was crossed."
    guardrail = "Do not invoke a model or modify source without a measurable signal."
  }
}

$signals = [ordered]@{
  focused_high_token_count = $focusedHigh.Count
  focused_high_token_median = Get-Median $tokenValues
  focused_high_token_max = $(if ($tokenValues.Count -gt 0) { [long](($tokenValues | Measure-Object -Maximum).Maximum) } else { 0 })
  unavailable_usage_count = $unavailable.Count
  turn_limit_count = $turnLimited.Count
}
$recommendationIds = @($recommendations | ForEach-Object { $_.id }) -join ","
$fingerprint = "$($signals.focused_high_token_count):$($signals.focused_high_token_median):$($signals.focused_high_token_max):$($signals.unavailable_usage_count):$($signals.turn_limit_count):$recommendationIds"

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
$reportPath = Join-Path $OutRoot "latest-proposal.json"
$previousFingerprint = ""
if (Test-Path -LiteralPath $reportPath) {
  try { $previousFingerprint = [string]((Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json).evolution_state.fingerprint) } catch {}
}

$report = [ordered]@{
  schema_version = "1.0"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  mode = "read_only_proposal"
  source = "usage_ledger_metrics_only"
  events_read = $events.Count
  thresholds = [ordered]@{ high_token_focused_inspection = $HighTokenThreshold; lookback = $Lookback }
  signals = $signals
  evolution_state = [ordered]@{
    fingerprint = $fingerprint
    previous_fingerprint = $previousFingerprint
    changed_since_last = [string]::IsNullOrWhiteSpace($previousFingerprint) -or $previousFingerprint -ne $fingerprint
  }
  recommendations = @($recommendations)
  permissions = [ordered]@{ source_write = $false; model_call = $false; commit = $false; deploy = $false; push = $false }
}

$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $reportPath -Encoding UTF8

if ($JsonOnly) { $report | ConvertTo-Json -Depth 7 -Compress }
else {
  Write-Host "AI Team evolution analysis complete."
  Write-Host "Proposal: $reportPath"
  Write-Host "Recommendations: $($recommendations.Count)"
}
