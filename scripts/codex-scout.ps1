[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$TaskId = "",

  [string]$Cwd = (Get-Location).Path,

  [ValidateSet("auto", "qwen", "deepseek", "grok")]
  [string]$Worker = "auto",

  [string]$MaxWallTime = "5m",

  [ValidateRange(3, 8)]
  [int]$MaxSessionTurns = 4,

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [int]$SummaryLines = 30,

  [int]$SummaryMaxChars = 3000,

  [ValidateRange(1000, 20000)]
  [int]$PackMaxChars = 10000,

  [switch]$JsonOnly,

  [switch]$DisableScoutPack,

  [switch]$ForceScoutPack,

  [switch]$PackModeOnly,

  [string]$UsageLedger = (Join-Path $env:USERPROFILE ".codex-ai-team\usage\worker-runs.jsonl")
)

$ErrorActionPreference = "Stop"
$wrapperStart = Get-Date

function Select-ScoutWorker {
  param([string]$Text)
  $lower = $Text.ToLowerInvariant()
  $codeWords = @("bug", "debug", "diff", "patch", "typescript", "javascript", "python", "powershell", "api", "test", "lint", "代码", "脚本", "报错", "修复")
  foreach ($word in $codeWords) {
    if ($lower.Contains($word.ToLowerInvariant())) {
      return "deepseek"
    }
  }
  return "qwen"
}

if ($Worker -eq "auto") {
  $Worker = Select-ScoutWorker -Text $Task
}

function Test-ScoutPackDisabled {
  if ($DisableScoutPack) { return $true, "explicit -DisableScoutPack switch" }
  if ($ForceScoutPack) { return $false, "explicit -ForceScoutPack switch" }
  $envVal = [Environment]::GetEnvironmentVariable("AI_TEAM_SCOUT_PACK", "Process")
  if ([string]::IsNullOrWhiteSpace($envVal)) {
    $envVal = [Environment]::GetEnvironmentVariable("AI_TEAM_SCOUT_PACK", "User")
  }
  if ([string]::IsNullOrWhiteSpace($envVal)) {
    $envVal = [Environment]::GetEnvironmentVariable("AI_TEAM_SCOUT_PACK", "Machine")
  }
  if (-not [string]::IsNullOrWhiteSpace($envVal)) {
    $lower = $envVal.Trim().ToLowerInvariant()
    if ($lower -in @("0", "false", "off")) {
      return $true, "AI_TEAM_SCOUT_PACK=$lower environment override"
    }
    if ($lower -in @("1", "true", "on")) {
      return $false, "AI_TEAM_SCOUT_PACK=$lower environment override"
    }
  }
  $broadInspection = $Task -match '(?i)\b(architecture|architectural|overview|pipeline|workflow|orchestration|staged|sequence|relationship|across|multi[- ]?(file|module)|implementation plan|explain how|map the project)\b|\u67b6\u6784|\u6574\u4f53|\u6d41\u7a0b|\u7f16\u6392|\u8de8\u6a21\u5757|\u591a\u6587\u4ef6|\u5982\u4f55\u5de5\u4f5c'
  if ($broadInspection) { return $false, "auto enabled for broad architecture or workflow inspection" }
  return $false, "auto enabled for bounded mechanical preflight"
}

$scoutPackDisabled, $scoutPackReason = Test-ScoutPackDisabled
if ($PackModeOnly) {
  [ordered]@{
    enabled = (-not [bool]$scoutPackDisabled)
    reason = [string]$scoutPackReason
  } | ConvertTo-Json -Compress
  return
}
$packStart = Get-Date
$pack = [pscustomobject]@{
  enabled = $true
  reason = ""
  content = "Mechanical Scout Pack unavailable; use bounded read-only tools only when required."
  char_count = 0
  max_chars = $PackMaxChars
  truncated = $false
  file_count = 0
  match_count = 0
  elapsed_ms = 0
}
if (-not $scoutPackDisabled) {
  $packScript = Join-Path $PSScriptRoot "codex-scout-pack.ps1"
  if (Test-Path -LiteralPath $packScript) {
    try {
      $packRaw = & $packScript -Task $Task -Cwd $Cwd -MaxChars $PackMaxChars -JsonOnly
      $pack = (($packRaw -join "`n") | ConvertFrom-Json)
      $pack | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
      $pack | Add-Member -NotePropertyName reason -NotePropertyValue $scoutPackReason -Force
      $pack | Add-Member -NotePropertyName elapsed_ms -NotePropertyValue [math]::Round(((Get-Date) - $packStart).TotalMilliseconds) -Force
    } catch {
      $pack.enabled = $false
      $pack.reason = "pack generation failed safely"
      $pack.content = "Mechanical Scout Pack failed safely; use bounded read-only tools only when required."
    }
  } else {
    $pack.enabled = $false
    $pack.reason = "pack generator not found"
    $pack.content = "Mechanical Scout Pack script not found; use bounded read-only tools only when required."
  }
} else {
  $pack.enabled = $false
  $pack.reason = $scoutPackReason
  $pack.elapsed_ms = 0
}

$packRules = $(if ($pack.enabled) {
@"
- Use the Mechanical Scout Pack below first. If it already answers the task, do not call any tools.
- The pack is generated directly from the current workspace. Treat facts present in it as authoritative for this run; do not re-verify them with tools.
- Call read-only tools only for a specific missing fact; do not repeat discovery already present in the pack.
"@
} else {
  "- Mechanical Scout Pack is disabled for this focused run. Use only the minimum bounded read-only tool calls needed."
})

$scoutTask = @"
You are a scout worker for Codex.
Do not edit files.
Do not install software.
Do not print huge logs or entire files.
Investigate the workspace and return concise findings only.

Rules:
$packRules
- Prefer exact file paths, likely files, relevant line numbers, and short excerpts.
- For logs, return only the relevant last lines or matched lines.
- If many files match, group them and show top candidates.
- Use at most $([Math]::Max(1, $MaxSessionTurns - 1)) assistant turns for tools. Once that budget is spent, call no more tools and return the final answer immediately.
- The final assistant turn must be tool-free and contain the requested conclusion, even if some evidence remains unavailable.
- Keep the final answer under 25 lines. Return conclusions, exact paths, and relevant line numbers only.
- Put detailed evidence in the worker result file; do not repeat it in the final answer.

Scout task:
$Task

Mechanical Scout Pack metadata: enabled=$($pack.enabled), reason=$($pack.reason), chars=$($pack.char_count), truncated=$($pack.truncated), files=$($pack.file_count), matches=$($pack.match_count)

$($pack.content)
"@

$workerScript = Join-Path $PSScriptRoot "codex-worker.ps1"
if (-not (Test-Path -LiteralPath $workerScript)) {
  throw "Worker script not found: $workerScript"
}

$workerArgs = @{
  Worker = $Worker
  Task = $scoutTask
  TaskId = $TaskId
  Cwd = $Cwd
  Approval = "auto"
  Budget = $Budget
  MaxWallTime = $MaxWallTime
  MaxSessionTurns = $MaxSessionTurns
  SummaryLines = $SummaryLines
  SummaryMaxChars = $SummaryMaxChars
}
if ($JsonOnly) {
  $workerArgs.JsonOnly = $true
  $workerRaw = & $workerScript @workerArgs
  $workerResult = (($workerRaw -join "`n") | ConvertFrom-Json)
  # The full filtered pack remains in the worker artifact. Keep MCP stdout
  # compact by returning only the original task plus pack metadata.
  $workerResult.task = $Task
  $wrapperElapsedMs = [math]::Round(((Get-Date) - $wrapperStart).TotalMilliseconds)
  $packMetadata = [ordered]@{
    enabled = [bool]$pack.enabled
    reason = [string]$pack.reason
    char_count = [int]$pack.char_count
    max_chars = [int]$pack.max_chars
    truncated = [bool]$pack.truncated
    file_count = [int]$pack.file_count
    match_count = [int]$pack.match_count
    elapsed_ms = [int]$pack.elapsed_ms
    wrapper_elapsed_ms = [int]$wrapperElapsedMs
  }
  $workerResult | Add-Member -NotePropertyName scout_pack -NotePropertyValue $packMetadata -Force
  try {
    $ledgerDir = Split-Path -Parent $UsageLedger
    if ($ledgerDir) { New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null }
    $usage = $workerResult.usage
    $ledgerEvent = [ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      kind = "scout_pack"
      task_id = [string]$workerResult.task_id
      worker = [string]$workerResult.worker
      model = [string]$workerResult.model
      status = [string]$workerResult.status
      enabled = [bool]$packMetadata.enabled
      reason = [string]$packMetadata.reason
      char_count = [int]$packMetadata.char_count
      truncated = [bool]$packMetadata.truncated
      pack_elapsed_ms = [int]$packMetadata.elapsed_ms
      wrapper_elapsed_ms = [int]$packMetadata.wrapper_elapsed_ms
      input_tokens = $(if ($usage) { $usage.input_tokens } else { $null })
      output_tokens = $(if ($usage) { $usage.output_tokens } else { $null })
      cache_read_tokens = $(if ($usage) { $usage.cache_read_tokens } else { $null })
      total_tokens = $(if ($usage) { $usage.total_tokens } else { $null })
      num_turns = $(if ($usage) { $usage.num_turns } else { $null })
    }
    Add-Content -LiteralPath $UsageLedger -Value ($ledgerEvent | ConvertTo-Json -Compress) -Encoding UTF8
  } catch {}
  $workerResult | ConvertTo-Json -Depth 6 -Compress
} else {
  Write-Host "Mechanical Scout Pack: enabled=$($pack.enabled); reason=$($pack.reason); $($pack.char_count) chars; truncated=$($pack.truncated)"
  & $workerScript @workerArgs
}
