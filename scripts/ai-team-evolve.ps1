[CmdletBinding()]
param(
  [string]$UsageLedger = (Join-Path $env:USERPROFILE ".codex-ai-team\usage\worker-runs.jsonl"),
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\evolution"),
  [string]$AuditRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\audit"),
  [ValidateRange(10, 5000)]
  [int]$Lookback = 500,
  [ValidateRange(1000, 1000000)]
  [long]$HighTokenThreshold = 20000,
  [ValidateRange(2, 100)]
  [int]$MinimumShadowSamples = 3,
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

# Join safe route-decision/checkpoint artifacts to provider-reported usage by
# task_id. This is intentionally shadow-only: it produces evidence and
# counterfactual suggestions but never changes production routing weights.
$shadowRuns = @()
if (Test-Path -LiteralPath $AuditRoot) {
  foreach ($routeFile in @(Get-ChildItem -LiteralPath $AuditRoot -Filter "route-decision.json" -File -Recurse -ErrorAction SilentlyContinue)) {
    try {
      $route = Get-Content -LiteralPath $routeFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      $checkpointPath = Join-Path $routeFile.Directory.FullName "checkpoint.json"
      $checkpoint = $(if (Test-Path -LiteralPath $checkpointPath) { Get-Content -LiteralPath $checkpointPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null })
      $taskEvents = @($events | Where-Object { [string]$_.task_id -eq [string]$route.task_id })
      $tokens = [long](($taskEvents | Measure-Object -Property total_tokens -Sum).Sum)
      $duration = [long](($taskEvents | Measure-Object -Property provider_duration_ms -Sum).Sum)
      $decision = [string]$checkpoint.last_gate.decision
      $shadowRuns += [pscustomobject]@{
        task_id = [string]$route.task_id
        route = "$([string]$route.selected.provider):$([string]$route.selected.id)"
        accepted = $decision -eq "accept"
        gate_decision = $decision
        total_tokens = $tokens
        provider_duration_ms = $duration
      }
    } catch {}
  }
}

$routePerformance = @()
foreach ($group in @($shadowRuns | Group-Object route)) {
  $rows = @($group.Group)
  $accepted = @($rows | Where-Object { $_.accepted }).Count
  $routePerformance += [pscustomobject][ordered]@{
    route = $group.Name
    samples = $rows.Count
    accepted = $accepted
    acceptance_rate = $(if ($rows.Count -gt 0) { [math]::Round($accepted / $rows.Count, 4) } else { 0 })
    median_total_tokens = Get-Median @($rows | ForEach-Object { [long]$_.total_tokens })
    median_provider_duration_ms = Get-Median @($rows | ForEach-Object { [long]$_.provider_duration_ms })
  }
}

$eligibleShadow = @($routePerformance | Where-Object { $_.samples -ge $MinimumShadowSamples } | Sort-Object @{Expression="acceptance_rate";Descending=$true}, @{Expression="median_total_tokens";Descending=$false})
$counterfactuals = @()
if ($eligibleShadow.Count -gt 1) {
  $best = $eligibleShadow[0]
  foreach ($current in @($eligibleShadow | Select-Object -Skip 1)) {
    if ($best.acceptance_rate -gt $current.acceptance_rate -or ($best.acceptance_rate -eq $current.acceptance_rate -and $best.median_total_tokens -lt $current.median_total_tokens)) {
      $counterfactuals += [ordered]@{
        current_route = $current.route
        shadow_route = $best.route
        evidence = "$($best.samples) vs $($current.samples) samples; acceptance $($best.acceptance_rate) vs $($current.acceptance_rate); median tokens $($best.median_total_tokens) vs $($current.median_total_tokens)"
        action = "observe_only"
      }
    }
  }
}

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
  source = "usage_ledger_and_route_audit_metrics"
  events_read = $events.Count
  thresholds = [ordered]@{ high_token_focused_inspection = $HighTokenThreshold; lookback = $Lookback }
  signals = $signals
  shadow_mode = [ordered]@{
    enabled = $true
    auto_apply = $false
    minimum_samples_per_route = $MinimumShadowSamples
    joined_run_count = $shadowRuns.Count
    route_performance = @($routePerformance)
    counterfactuals = @($counterfactuals)
  }
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
