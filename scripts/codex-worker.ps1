[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("qwen", "deepseek")]
  [string]$Worker,

  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$Cwd = (Get-Location).Path,

  [ValidateSet("auto", "default", "yolo", "plan")]
  [string]$Approval = "auto",

  [string]$MaxWallTime = "8m",

  [string]$QwenModel = "qwen3.7-plus",

  [string]$DeepSeekModel = "deepseek-v4-pro[1m]",

  [decimal]$DeepSeekMaxBudgetUsd = 0.03,

  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\runs"),

  [int]$SummaryLines = 30,

  [int]$SummaryMaxChars = 3000
)

$ErrorActionPreference = "Stop"
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Get-EnvValue {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, "User")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Machine")
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  }
  return $value
}

function Add-ToolPath {
  $extraDirs = @(
    $env:AI_TEAM_NODE_DIR,
    $env:AI_TEAM_GIT_DIR,
    $env:AI_TEAM_TOOLS_DIR,
    (Join-Path $env:APPDATA "npm")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($extraDirs.Count -gt 0) {
    $env:Path = (($extraDirs + $env:Path) -join ";")
  }
}

function New-RunDir {
  param([string]$Kind)
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dir = Join-Path $OutRoot "$timestamp-$Kind"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

if (-not (Test-Path -LiteralPath $Cwd)) {
  throw "Cwd does not exist: $Cwd"
}

Add-ToolPath
$runDir = New-RunDir -Kind $Worker
$taskPath = Join-Path $runDir "task.txt"
$resultPath = Join-Path $runDir "result.txt"
$summaryPath = Join-Path $runDir "summary.txt"
$metaPath = Join-Path $runDir "meta.txt"

$Task | Set-Content -LiteralPath $taskPath -Encoding UTF8

$workerPrompt = @"
You are a background worker called by Codex, who is the marshal and final reviewer.
Do useful work directly when your tool mode allows it. Keep the task tightly scoped.
Prefer making concrete progress over long discussion.
Do not touch secrets, payment data, accounts, unrelated user files, drivers, registry, or system settings unless the user task explicitly asks for it.
Do not run long downloads or installations unless the task explicitly asks for that.
At the end, report:
- what you changed or produced
- exact file paths changed
- commands/tests run
- blockers or risks for Codex to handle

Task from Codex:
$Task
"@

$meta = @()
$meta += "Worker: $Worker"
$meta += "Cwd: $Cwd"
$meta += "RunDir: $runDir"
$meta += "Approval: $Approval"
$meta += "MaxWallTime: $MaxWallTime"
$meta | Set-Content -LiteralPath $metaPath -Encoding UTF8

Push-Location $Cwd
try {
  if ($Worker -eq "qwen") {
    $dashscope = Get-EnvValue "DASHSCOPE_API_KEY"
    $openaiKey = Get-EnvValue "OPENAI_API_KEY"
    if ([string]::IsNullOrWhiteSpace($openaiKey)) {
      $openaiKey = $dashscope
    }
    if ([string]::IsNullOrWhiteSpace($openaiKey)) {
      throw "OPENAI_API_KEY or DASHSCOPE_API_KEY is not configured."
    }
    $env:DASHSCOPE_API_KEY = $dashscope
    $env:OPENAI_API_KEY = $openaiKey
    $qwenBaseUrl = Get-EnvValue "QWEN_MCP_BASE_URL"
    if ([string]::IsNullOrWhiteSpace($qwenBaseUrl)) {
      $qwenBaseUrl = Get-EnvValue "OPENAI_BASE_URL"
    }
    if ([string]::IsNullOrWhiteSpace($qwenBaseUrl)) {
      $qwenBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
    $env:OPENAI_BASE_URL = $qwenBaseUrl

    $qwenArgs = @(
      "--prompt", $workerPrompt,
      "--auth-type", "openai",
      "--model", $QwenModel,
      "--openai-base-url", $env:OPENAI_BASE_URL,
      "--approval-mode", $Approval,
      "--max-wall-time", $MaxWallTime,
      "--max-session-turns", "8",
      "--output-format", "text"
    )
    & qwen @qwenArgs > $resultPath 2>&1
    $workerExitCode = $LASTEXITCODE
  }

  if ($Worker -eq "deepseek") {
    $authToken = Get-EnvValue "ANTHROPIC_AUTH_TOKEN"
    $apiKey = Get-EnvValue "ANTHROPIC_API_KEY"
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      $apiKey = $authToken
    }
    if ([string]::IsNullOrWhiteSpace($authToken)) {
      $authToken = $apiKey
    }
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      throw "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not configured."
    }

    $deepSeekBaseUrl = Get-EnvValue "DEEPSEEK_MCP_BASE_URL"
    if ([string]::IsNullOrWhiteSpace($deepSeekBaseUrl)) {
      $deepSeekBaseUrl = Get-EnvValue "ANTHROPIC_BASE_URL"
    }
    if ([string]::IsNullOrWhiteSpace($deepSeekBaseUrl)) {
      $deepSeekBaseUrl = "https://api.deepseek.com/anthropic"
    }
    $env:ANTHROPIC_BASE_URL = $deepSeekBaseUrl
    $env:ANTHROPIC_AUTH_TOKEN = $authToken
    $env:ANTHROPIC_API_KEY = $apiKey
    $env:ANTHROPIC_MODEL = $DeepSeekModel
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = $DeepSeekModel
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $DeepSeekModel
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
    $env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"

    $permissionMode = "auto"
    if ($Approval -eq "yolo") {
      $permissionMode = "bypassPermissions"
    } elseif ($Approval -eq "plan") {
      $permissionMode = "plan"
    } elseif ($Approval -eq "default") {
      $permissionMode = "default"
    }

    $claudeArgs = @(
      "--print",
      "--bare",
      "--model", $DeepSeekModel,
      "--permission-mode", $permissionMode,
      "--max-budget-usd", ([string]$DeepSeekMaxBudgetUsd),
      "--append-system-prompt", "Answer for Codex. Be concise. Codex is final reviewer.",
      $workerPrompt
    )
    & claude @claudeArgs > $resultPath 2>&1
    $workerExitCode = $LASTEXITCODE
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Worker finished."
Write-Host "RunDir: $runDir"
Write-Host "Result: $resultPath"
Write-Host "Summary: $summaryPath"
if ($null -ne $workerExitCode) {
  Write-Host "ExitCode: $workerExitCode"
}
Write-Host ""
Write-Host "---- compact summary ----"
if (Test-Path -LiteralPath $resultPath) {
  $summaryText = ((Get-Content -LiteralPath $resultPath -Tail $SummaryLines) -join [Environment]::NewLine).Trim()
  if ($summaryText.Length -gt $SummaryMaxChars) {
    $summaryText = "[truncated to final $SummaryMaxChars characters]" + [Environment]::NewLine + $summaryText.Substring($summaryText.Length - $SummaryMaxChars)
  }
  $summaryText | Set-Content -LiteralPath $summaryPath -Encoding UTF8
  Write-Host $summaryText
}
