[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^T[1-8]$")]
  [string]$TaskId,
  [switch]$Execute,
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\benchmark")
)

$ErrorActionPreference = "Stop"
$prepared = & (Join-Path $PSScriptRoot "prepare-benchmark.ps1") -TaskId $TaskId -OutRoot (Join-Path $OutRoot "workspaces")
$task = $prepared.Task
$workspace = $prepared.Workspace

Write-Host "Benchmark: $($task.id) - $($task.title)"
Write-Host "Workspace: $workspace"
Write-Host "Worker: $($task.worker) | Budget: $($task.budget)"
Write-Host "Prompt: $($task.prompt)"

if (-not $Execute) {
  Write-Host "Prepared only. Add -Execute to spend model tokens and run the task."
  return
}

$records = Join-Path $OutRoot "records"
New-Item -ItemType Directory -Force -Path $records | Out-Null
$workerOut = Join-Path $records $TaskId
$allowed = @($task.allowed_paths)

if ($task.readonly) {
  & (Join-Path $PSScriptRoot "..\scripts\codex-scout.ps1") `
    -Task $task.prompt -Cwd $workspace -Worker $task.worker -Budget $task.budget -MaxWallTime "5m"
  return
}

& (Join-Path $PSScriptRoot "..\scripts\codex-worker.ps1") `
  -Worker $task.worker `
  -Task $task.prompt `
  -TaskId "benchmark-$TaskId" `
  -Attempt 1 `
  -Cwd $workspace `
  -AllowedPath $allowed `
  -Budget $task.budget `
  -Approval yolo `
  -OutRoot $workerOut

$workerRun = Get-ChildItem -LiteralPath $workerOut -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$requirementStatus = "fail"
& node (Join-Path $PSScriptRoot "evaluate-benchmark.mjs") $TaskId $workspace
if ($LASTEXITCODE -eq 0) { $requirementStatus = "pass" }

$gateRaw = & (Join-Path $PSScriptRoot "..\scripts\codex-gate.ps1") `
  -Cwd $workspace `
  -TaskId "benchmark-$TaskId" `
  -Task $task.prompt `
  -Attempt 1 `
  -RequirementStatus $requirementStatus `
  -AllowedPath $allowed `
  -WorkerRunDir $workerRun.FullName `
  -OutRoot (Join-Path $records "$TaskId-gate") `
  -JsonOnly

$handoff = ($gateRaw -join "`n") | ConvertFrom-Json
$workerResult = Get-Content (Join-Path $workerRun.FullName "worker-result.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$benchmarkEvent = [ordered]@{
  schema_version = "1.0"
  timestamp = (Get-Date).ToUniversalTime().ToString("o")
  task_id = $TaskId
  provider = $workerResult.worker
  model = $workerResult.model
  budget = $workerResult.budget
  worker_success = $workerResult.status -eq "success"
  hidden_acceptance = $requirementStatus -eq "pass"
  decision = $handoff.decision
  score = $handoff.score
  changed_files = $handoff.metrics.changed_files
  diff_lines = $handoff.metrics.diff_lines
  workspace = $workspace
  handoff = $handoff.artifacts.handoff
}
Add-Content -LiteralPath (Join-Path $OutRoot "benchmark-results.jsonl") -Value ($benchmarkEvent | ConvertTo-Json -Compress) -Encoding UTF8

Write-Host "Benchmark result: $($handoff.score) -> $($handoff.decision.ToUpperInvariant())"
Write-Host "Handoff: $($handoff.artifacts.handoff)"
