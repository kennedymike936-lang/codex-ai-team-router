[CmdletBinding()]
param(
  [string]$Cwd = "",

  [string]$TaskFile = "",

  [ValidateSet("qwen", "deepseek")]
  [string]$Worker = "qwen",

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [string]$MaxWallTime = "3m",

  [ValidateRange(2, 8)]
  [int]$MaxSessionTurns = 4,

  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\benchmarks"),

  [string]$ReuseResultJson = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Cwd)) { $Cwd = $repoRoot }
if ([string]::IsNullOrWhiteSpace($TaskFile)) { $TaskFile = Join-Path $PSScriptRoot "scout-pack-tasks.json" }
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path
$TaskFile = (Resolve-Path -LiteralPath $TaskFile).Path
$scoutScript = Join-Path $repoRoot "scripts\codex-scout.ps1"
if (-not (Test-Path -LiteralPath $scoutScript)) { throw "Scout script not found: $scoutScript" }
$parsedTasks = Get-Content -LiteralPath $TaskFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tasks = @($parsedTasks | ForEach-Object { $_ })
if ($tasks.Count -ne 3) { throw "Benchmark requires exactly 3 tasks; found $($tasks.Count)." }

$plan = @()
foreach ($task in $tasks) {
  foreach ($mode in @("off", "on")) {
    $plan += [pscustomobject]@{ task_id = [string]$task.id; pack = $mode; worker = $Worker; budget = $Budget }
  }
}
if ($DryRun) {
  Write-Host "Scout Pack benchmark dry run: $($plan.Count) planned model runs; no model calls made."
  $plan | Format-Table -AutoSize
  return
}

function Get-Median {
  param([double[]]$Values)
  $sorted = @($Values | Sort-Object)
  if ($sorted.Count -eq 0) { return 0 }
  $middle = [math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 1) { return [double]$sorted[$middle] }
  return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2
}

function Get-Rate {
  param([object[]]$Rows, [scriptblock]$Predicate)
  if ($Rows.Count -eq 0) { return 0 }
  $matched = @($Rows | Where-Object $Predicate).Count
  return [math]::Round(100 * $matched / $Rows.Count, 1)
}

if (-not [string]::IsNullOrWhiteSpace($ReuseResultJson)) {
  $reusePath = (Resolve-Path -LiteralPath $ReuseResultJson).Path
  $reused = Get-Content -LiteralPath $reusePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $results = @($reused.results | ForEach-Object { $_ })
  if ($results.Count -ne $plan.Count) { throw "Reused benchmark must contain exactly $($plan.Count) results; found $($results.Count)." }
  Write-Host "Reusing $($results.Count) existing model results; no model calls made."
} else {
  $results = @()
  foreach ($task in $tasks) {
    foreach ($mode in @("off", "on")) {
      Write-Host "Running $($task.id) pack=$mode ..."
      $arguments = @{
        Task = [string]$task.task
        Cwd = $Cwd
        Worker = $Worker
        Budget = $Budget
        MaxWallTime = $MaxWallTime
        MaxSessionTurns = $MaxSessionTurns
        SummaryMaxChars = 1200
        JsonOnly = $true
      }
      if ($mode -eq "off") { $arguments.DisableScoutPack = $true }
      else { $arguments.ForceScoutPack = $true }
      $started = Get-Date
      $raw = & $scoutScript @arguments
      $elapsedMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
      $result = (($raw -join "`n") | ConvertFrom-Json)
      $summary = [string]$result.summary
      $expected = @($task.expected | ForEach-Object { [string]$_ })
      $matched = @($expected | Where-Object { $summary -match $_ }).Count
      $qualityPass = $result.status -eq "success" -and $matched -eq $expected.Count
      $results += [pscustomobject][ordered]@{
        task_id = [string]$task.id
        pack = $mode
        worker = [string]$result.worker
        model = [string]$result.model
        status = [string]$result.status
        quality_pass = [bool]$qualityPass
        expected_matched = $matched
        expected_total = $expected.Count
        input_tokens = [long]$result.usage.input_tokens
        output_tokens = [long]$result.usage.output_tokens
        cache_read_tokens = [long]$result.usage.cache_read_tokens
        total_tokens = [long]$result.usage.total_tokens
        num_turns = [int]$result.usage.num_turns
        wall_time_ms = [int]$elapsedMs
        pack_chars = [int]$result.scout_pack.char_count
        pack_elapsed_ms = [int]$result.scout_pack.elapsed_ms
        pack_truncated = [bool]$result.scout_pack.truncated
        run_dir = [string]$result.artifacts.run_dir
      }
    }
  }
}

$autoRows = @()
$previousPackMode = $env:AI_TEAM_SCOUT_PACK
try {
  Remove-Item Env:AI_TEAM_SCOUT_PACK -ErrorAction SilentlyContinue
  foreach ($task in $tasks) {
    $modeResult = (((& $scoutScript -Task ([string]$task.task) -Cwd $Cwd -PackModeOnly -JsonOnly) -join "`n") | ConvertFrom-Json)
    $selectedMode = $(if ($modeResult.enabled) { "on" } else { "off" })
    $selected = @($results | Where-Object { $_.task_id -eq [string]$task.id -and $_.pack -eq $selectedMode })
    if ($selected.Count -ne 1) { throw "Expected one reusable row for task '$($task.id)' pack=$selectedMode; found $($selected.Count)." }
    $row = $selected[0] | Select-Object *
    $row.pack = "auto"
    $row | Add-Member -NotePropertyName selected_pack -NotePropertyValue $selectedMode
    $row | Add-Member -NotePropertyName selection_reason -NotePropertyValue ([string]$modeResult.reason)
    $autoRows += $row
  }
} finally {
  if ($null -eq $previousPackMode) { Remove-Item Env:AI_TEAM_SCOUT_PACK -ErrorAction SilentlyContinue }
  else { $env:AI_TEAM_SCOUT_PACK = $previousPackMode }
}

$onRows = @($results | Where-Object pack -eq "on")
$offRows = @($results | Where-Object pack -eq "off")
$onMeasuredRows = @($onRows | Where-Object { $_.total_tokens -gt 0 })
$offMeasuredRows = @($offRows | Where-Object { $_.total_tokens -gt 0 })
$onMedianTokens = Get-Median -Values @($onMeasuredRows | ForEach-Object { [double]$_.total_tokens })
$offMedianTokens = Get-Median -Values @($offMeasuredRows | ForEach-Object { [double]$_.total_tokens })
$medianSavingsPct = $(if ($offMedianTokens -gt 0) { [math]::Round(100 * ($offMedianTokens - $onMedianTokens) / $offMedianTokens, 1) } else { 0 })
$onQuality = Get-Rate -Rows $onRows -Predicate { $_.quality_pass }
$offQuality = Get-Rate -Rows $offRows -Predicate { $_.quality_pass }
$onOneTurn = Get-Rate -Rows $onRows -Predicate { $_.num_turns -le 1 }
$offOneTurn = Get-Rate -Rows $offRows -Predicate { $_.num_turns -le 1 }
$autoMeasuredRows = @($autoRows | Where-Object { $_.total_tokens -gt 0 })
$autoMedianTokens = Get-Median -Values @($autoMeasuredRows | ForEach-Object { [double]$_.total_tokens })
$autoQuality = Get-Rate -Rows $autoRows -Predicate { $_.quality_pass }
$autoOneTurn = Get-Rate -Rows $autoRows -Predicate { $_.num_turns -le 1 }
$onTotalTokens = [long](($onMeasuredRows | Measure-Object total_tokens -Sum).Sum)
$offTotalTokens = [long](($offMeasuredRows | Measure-Object total_tokens -Sum).Sum)
$autoTotalTokens = [long](($autoMeasuredRows | Measure-Object total_tokens -Sum).Sum)
$autoTotalSavingsPct = $(if ($offTotalTokens -gt 0) { [math]::Round(100 * ($offTotalTokens - $autoTotalTokens) / $offTotalTokens, 1) } else { 0 })
$globalPackAcceptable = $onQuality -eq 100 -and $onQuality -ge $offQuality -and $onMedianTokens -gt 0 -and $onMedianTokens -lt $offMedianTokens
$selectiveAutoAcceptable = $autoQuality -eq 100 -and $autoQuality -ge $offQuality -and $autoTotalTokens -gt 0 -and $autoTotalTokens -lt $offTotalTokens -and $autoMedianTokens -le $offMedianTokens

$summary = [ordered]@{
  schema_version = "1.1"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  worker = $Worker
  task_count = $tasks.Count
  run_count = $results.Count
  max_session_turns = $MaxSessionTurns
  pack_on = [ordered]@{
    measured_total_tokens = $onTotalTokens
    failed_run_count = @($onRows | Where-Object status -ne "success").Count
    median_tokens = [double]$onMedianTokens
    median_wall_time_ms = [double](Get-Median -Values @($onRows | ForEach-Object { [double]$_.wall_time_ms }))
    one_turn_rate_pct = $onOneTurn
    quality_pass_rate_pct = $onQuality
  }
  pack_off = [ordered]@{
    measured_total_tokens = $offTotalTokens
    failed_run_count = @($offRows | Where-Object status -ne "success").Count
    median_tokens = [double]$offMedianTokens
    median_wall_time_ms = [double](Get-Median -Values @($offRows | ForEach-Object { [double]$_.wall_time_ms }))
    one_turn_rate_pct = $offOneTurn
    quality_pass_rate_pct = $offQuality
  }
  selective_auto = [ordered]@{
    measured_total_tokens = $autoTotalTokens
    failed_run_count = @($autoRows | Where-Object status -ne "success").Count
    median_tokens = [double]$autoMedianTokens
    median_wall_time_ms = [double](Get-Median -Values @($autoRows | ForEach-Object { [double]$_.wall_time_ms }))
    one_turn_rate_pct = $autoOneTurn
    quality_pass_rate_pct = $autoQuality
    total_token_savings_vs_off_pct = $autoTotalSavingsPct
    selected_modes = @($autoRows | ForEach-Object { [ordered]@{ task_id = $_.task_id; pack = $_.selected_pack; reason = $_.selection_reason } })
  }
  median_token_savings_pct = $medianSavingsPct
  global_pack_acceptable = [bool]$globalPackAcceptable
  selective_auto_acceptable = [bool]$selectiveAutoAcceptable
  rollout_acceptable = [bool]$selectiveAutoAcceptable
  recommendation = $(if ($selectiveAutoAcceptable) { "Use selective AUTO routing; do not enable Mechanical Scout Pack globally." } elseif ($globalPackAcceptable) { "Keep Mechanical Scout Pack enabled by default." } else { "Keep Mechanical Scout Pack disabled by default; quality or token criteria were not met." })
}

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonPath = Join-Path $OutRoot "$stamp-scout-pack-benchmark.json"
$markdownPath = Join-Path $OutRoot "$stamp-scout-pack-benchmark.md"
[ordered]@{ summary = $summary; results = @($results); selective_auto_results = @($autoRows) } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$autoSelectionText = @($autoRows | ForEach-Object { "$($_.task_id)=$($_.selected_pack)" }) -join ", "
$lines = @(
  "# Mechanical Scout Pack Benchmark",
  "",
  "Decision: $(if ($selectiveAutoAcceptable) { 'ACCEPT SELECTIVE AUTO' } elseif ($globalPackAcceptable) { 'ACCEPT GLOBAL PACK' } else { 'DO NOT ROLL OUT' })",
  "Recommendation: $($summary.recommendation)",
  "Global Pack median token savings: $medianSavingsPct%",
  "Selective AUTO total token savings: $autoTotalSavingsPct%",
  "",
  "| Mode | Measured tokens | Failed runs | Median tokens | Median ms | One-turn rate | Quality pass |",
  "|---|---:|---:|---:|---:|---:|---:|",
  "| Pack ON | $($summary.pack_on.measured_total_tokens) | $($summary.pack_on.failed_run_count) | $($summary.pack_on.median_tokens) | $($summary.pack_on.median_wall_time_ms) | $onOneTurn% | $onQuality% |",
  "| Pack OFF | $($summary.pack_off.measured_total_tokens) | $($summary.pack_off.failed_run_count) | $($summary.pack_off.median_tokens) | $($summary.pack_off.median_wall_time_ms) | $offOneTurn% | $offQuality% |",
  "| Selective AUTO | $($summary.selective_auto.measured_total_tokens) | $($summary.selective_auto.failed_run_count) | $($summary.selective_auto.median_tokens) | $($summary.selective_auto.median_wall_time_ms) | $autoOneTurn% | $autoQuality% |",
  "",
  "AUTO selections: $autoSelectionText",
  "",
  "Per-run reports store metrics and deterministic expected-match counts only; task answers and pack content are omitted."
)
$lines | Set-Content -LiteralPath $markdownPath -Encoding UTF8

Write-Host "Benchmark complete."
Write-Host "JSON: $jsonPath"
Write-Host "Markdown: $markdownPath"
Write-Host "Global Pack acceptable: $globalPackAcceptable"
Write-Host "Selective AUTO acceptable: $selectiveAutoAcceptable"
Write-Host "Selective AUTO total token savings: $autoTotalSavingsPct%"
