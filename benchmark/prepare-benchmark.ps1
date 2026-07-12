[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^T[1-8]$")]
  [string]$TaskId,
  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\benchmark\workspaces")
)

$ErrorActionPreference = "Stop"
$tasks = Get-Content (Join-Path $PSScriptRoot "tasks.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$task = $tasks | Where-Object id -eq $TaskId | Select-Object -First 1
if (-not $task) { throw "Unknown benchmark task: $TaskId" }

$workspace = Join-Path $OutRoot "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$TaskId"
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot "fixture\*") -Destination $workspace -Recurse -Force

Push-Location $workspace
try {
  git init -q
  git config user.name "AI Team Benchmark"
  git config user.email "ai-team-benchmark@example.invalid"
  git add .
  git commit -q -m "benchmark fixture"
} finally {
  Pop-Location
}

[pscustomobject]@{
  Task = $task
  Workspace = $workspace
}
