[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$Cwd = (Get-Location).Path,

  [ValidateSet("auto", "qwen", "deepseek")]
  [string]$Worker = "auto",

  [string]$MaxWallTime = "5m",

  [ValidateRange(2, 8)]
  [int]$MaxSessionTurns = 2,

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [int]$SummaryLines = 30,

  [int]$SummaryMaxChars = 3000,

  [ValidateRange(1000, 20000)]
  [int]$PackMaxChars = 10000,

  [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"

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

$pack = [pscustomobject]@{
  content = "Mechanical Scout Pack unavailable; use bounded read-only tools only when required."
  char_count = 0
  max_chars = $PackMaxChars
  truncated = $false
  file_count = 0
  match_count = 0
}
$packScript = Join-Path $PSScriptRoot "codex-scout-pack.ps1"
if (Test-Path -LiteralPath $packScript) {
  try {
    $packRaw = & $packScript -Task $Task -Cwd $Cwd -MaxChars $PackMaxChars -JsonOnly
    $pack = (($packRaw -join "`n") | ConvertFrom-Json)
  } catch {
    $pack.content = "Mechanical Scout Pack failed safely; use bounded read-only tools only when required."
  }
}

$scoutTask = @"
You are a scout worker for Codex.
Do not edit files.
Do not install software.
Do not print huge logs or entire files.
Investigate the workspace and return concise findings only.

Rules:
- Use the Mechanical Scout Pack below first. If it already answers the task, do not call any tools.
- Call read-only tools only for a specific missing fact; do not repeat discovery already present in the pack.
- Prefer exact file paths, likely files, relevant line numbers, and short excerpts.
- For logs, return only the relevant last lines or matched lines.
- If many files match, group them and show top candidates.
- Keep the final answer under 25 lines. Return conclusions, exact paths, and relevant line numbers only.
- Put detailed evidence in the worker result file; do not repeat it in the final answer.

Scout task:
$Task

Mechanical Scout Pack metadata: chars=$($pack.char_count), truncated=$($pack.truncated), files=$($pack.file_count), matches=$($pack.match_count)

$($pack.content)
"@

$workerScript = Join-Path $PSScriptRoot "codex-worker.ps1"
if (-not (Test-Path -LiteralPath $workerScript)) {
  throw "Worker script not found: $workerScript"
}

$workerArgs = @{
  Worker = $Worker
  Task = $scoutTask
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
  $workerResult | Add-Member -NotePropertyName scout_pack -NotePropertyValue ([ordered]@{
    char_count = [int]$pack.char_count
    max_chars = [int]$pack.max_chars
    truncated = [bool]$pack.truncated
    file_count = [int]$pack.file_count
    match_count = [int]$pack.match_count
  }) -Force
  $workerResult | ConvertTo-Json -Depth 6 -Compress
} else {
  Write-Host "Mechanical Scout Pack: $($pack.char_count) chars; truncated=$($pack.truncated)"
  & $workerScript @workerArgs
}
