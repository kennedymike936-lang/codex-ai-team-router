[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$Cwd = (Get-Location).Path,

  [ValidateSet("auto", "qwen", "deepseek")]
  [string]$Worker = "auto",

  [string]$MaxWallTime = "5m",

  [ValidateRange(2, 8)]
  [int]$MaxSessionTurns = 4,

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [int]$SummaryLines = 30,

  [int]$SummaryMaxChars = 3000,

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

$scoutTask = @"
You are a scout worker for Codex.
Do not edit files.
Do not install software.
Do not print huge logs or entire files.
Investigate the workspace and return concise findings only.

Rules:
- Prefer exact file paths, likely files, relevant line numbers, and short excerpts.
- For logs, return only the relevant last lines or matched lines.
- If many files match, group them and show top candidates.
- Keep the final answer under 25 lines. Return conclusions, exact paths, and relevant line numbers only.
- Put detailed evidence in the worker result file; do not repeat it in the final answer.

Scout task:
$Task
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
if ($JsonOnly) { $workerArgs.JsonOnly = $true }

& $workerScript @workerArgs
