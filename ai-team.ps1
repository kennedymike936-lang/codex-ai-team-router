[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Task,

  [ValidateSet("auto", "qwen", "deepseek", "both", "plan")]
  [string]$Mode = "auto",

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [string]$OutRoot = "D:\AI-Team\runs",

  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function U {
  param([int[]]$CodePoints)
  return -join ($CodePoints | ForEach-Object { [char]$_ })
}

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

function Get-MaxTokens {
  param([string]$Level)
  switch ($Level) {
    "low" { return 1200 }
    "normal" { return 2600 }
    "deep" { return 5200 }
  }
}

function Has-AnyWord {
  param([string]$Text, [string[]]$Words)
  foreach ($word in $Words) {
    if ($Text -like "*$word*") {
      return $true
    }
  }
  return $false
}

function Select-Providers {
  param([string]$Text, [string]$SelectedMode)

  switch ($SelectedMode) {
    "qwen" { return @("qwen") }
    "deepseek" { return @("deepseek") }
    "both" { return @("qwen", "deepseek") }
    "plan" { return @() }
  }

  $codeWords = @(
    "code", "script", "bug", "debug", "fix", "PowerShell", "Python",
    "JavaScript", "TypeScript", "Node", "npm", "git", "API", "test",
    (U 0x4EE3,0x7801),
    (U 0x811A,0x672C),
    (U 0x62A5,0x9519),
    (U 0x4FEE,0x590D),
    (U 0x6D4B,0x8BD5),
    (U 0x91CD,0x6784)
  )
  $wideWords = @(
    "plan", "architecture", "compare", "evaluate", "automation",
    "install", "system", "tool",
    (U 0x65B9,0x6848),
    (U 0x67B6,0x6784),
    (U 0x6BD4,0x8F83),
    (U 0x590D,0x6742),
    (U 0x81EA,0x52A8,0x5316),
    (U 0x5DE5,0x5177),
    (U 0x5B89,0x88C5),
    (U 0x7CFB,0x7EDF)
  )
  $writingWords = @(
    "summary", "summarize", "draft", "organize", "translate", "rewrite",
    "table", "notes", "outline",
    (U 0x603B,0x7ED3),
    (U 0x6574,0x7406),
    (U 0x5F52,0x7EB3),
    (U 0x7FFB,0x8BD1),
    (U 0x6DA6,0x8272),
    (U 0x6587,0x6848),
    (U 0x6E05,0x5355),
    (U 0x8868,0x683C)
  )

  $hasCode = Has-AnyWord -Text $Text -Words $codeWords
  $hasWide = Has-AnyWord -Text $Text -Words $wideWords
  $hasWriting = Has-AnyWord -Text $Text -Words $writingWords

  if ($hasCode -and $hasWide) {
    return @("qwen", "deepseek")
  }
  if ($hasCode) {
    return @("deepseek")
  }
  if ($hasWriting) {
    return @("qwen")
  }
  return @("qwen")
}

function Invoke-OpenAIChat {
  param(
    [string]$BaseUrl,
    [string]$ApiKey,
    [string]$Model,
    [string]$SystemPrompt,
    [string]$UserPrompt,
    [int]$MaxTokens
  )

  $uri = $BaseUrl.TrimEnd("/") + "/chat/completions"
  $headers = @{
    Authorization = "Bearer $ApiKey"
  }
  $bodyObject = @{
    model = $Model
    messages = @(
      @{ role = "system"; content = $SystemPrompt },
      @{ role = "user"; content = $UserPrompt }
    )
    temperature = 0.2
    max_tokens = $MaxTokens
    stream = $false
  }
  $body = $bodyObject | ConvertTo-Json -Depth 12
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 180
  return [string]$response.choices[0].message.content
}

function Invoke-AnthropicMessages {
  param(
    [string]$BaseUrl,
    [string]$ApiKey,
    [string]$Model,
    [string]$SystemPrompt,
    [string]$UserPrompt,
    [int]$MaxTokens
  )

  $uri = $BaseUrl.TrimEnd("/") + "/v1/messages"
  $bodyObject = @{
    model = $Model
    max_tokens = $MaxTokens
    temperature = 0.2
    system = $SystemPrompt
    messages = @(
      @{ role = "user"; content = $UserPrompt }
    )
  }
  $body = $bodyObject | ConvertTo-Json -Depth 12
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

  $headerSets = @(
    @{
      "x-api-key" = $ApiKey
      "anthropic-version" = "2023-06-01"
    },
    @{
      Authorization = "Bearer $ApiKey"
      "anthropic-version" = "2023-06-01"
    }
  )

  $lastError = $null
  foreach ($headers in $headerSets) {
    try {
      $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 180
      $parts = @()
      foreach ($part in $response.content) {
        if ($part.text) {
          $parts += [string]$part.text
        }
      }
      return ($parts -join "`n")
    } catch {
      $lastError = $_
    }
  }
  throw $lastError
}

if ([string]::IsNullOrWhiteSpace($Task)) {
  $Task = Read-Host "Enter a task for AI Team"
}
if ([string]::IsNullOrWhiteSpace($Task)) {
  throw "Task is empty."
}

$maxTokens = Get-MaxTokens -Level $Budget
$providers = Select-Providers -Text $Task -SelectedMode $Mode
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutRoot $timestamp
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$taskPath = Join-Path $runDir "task.txt"
$Task | Set-Content -LiteralPath $taskPath -Encoding UTF8

$systemPrompt = @"
You are an AI worker under Codex, the marshal.
Your job is to save Codex main-model tokens by producing drafts, summaries, plans, risk notes, or implementation sketches first.
Do not claim you have operated on the user's computer. Unless the task only asks for text, do not claim you created, deleted, installed, or modified anything.
For downloads, installs, deletes, system settings, registry changes, drivers, accounts, secrets, or payments, only provide recommendations and risks. Wait for Codex or the user to confirm before any real operation.
Always answer in Simplified Chinese. Keep the answer short, clear, and ready for Codex to continue.
"@

$userPrompt = @"
User task:
$Task

Please output:
1. Your understanding of the task
2. Suggested steps
3. Risks and items that Codex must confirm, if this involves code or computer operations
4. Reusable draft text, commands, code, or checklist
"@

$results = @()

if ($Mode -eq "plan") {
  $route = Select-Providers -Text $Task -SelectedMode "auto"
  $planText = @"
# AI Team Plan

Task:
$Task

Recommended workers:
$($route -join ", ")

Budget:
$Budget

No API call was made because mode is plan.
"@
  $planPath = Join-Path $runDir "plan.md"
  $planText | Set-Content -LiteralPath $planPath -Encoding UTF8
  $results += $planPath
}

foreach ($provider in $providers) {
  $resultPath = Join-Path $runDir "$provider.md"
  try {
    if ($provider -eq "qwen") {
      $apiKey = Get-EnvValue "DASHSCOPE_API_KEY"
      if ([string]::IsNullOrWhiteSpace($apiKey)) {
        $apiKey = Get-EnvValue "OPENAI_API_KEY"
      }
      if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw "Qwen API key is not configured in user environment."
      }
      $baseUrl = Get-EnvValue "OPENAI_BASE_URL"
      if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
      $model = Get-EnvValue "AI_TEAM_QWEN_MODEL"
      if ([string]::IsNullOrWhiteSpace($model)) {
        $model = "qwen3.7-plus"
      }
      $content = Invoke-OpenAIChat -BaseUrl $baseUrl -ApiKey $apiKey -Model $model -SystemPrompt $systemPrompt -UserPrompt $userPrompt -MaxTokens $maxTokens
    }

    if ($provider -eq "deepseek") {
      $apiKey = Get-EnvValue "ANTHROPIC_API_KEY"
      if ([string]::IsNullOrWhiteSpace($apiKey)) {
        $apiKey = Get-EnvValue "ANTHROPIC_AUTH_TOKEN"
      }
      if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw "DeepSeek API key is not configured in user environment."
      }
      $baseUrl = Get-EnvValue "ANTHROPIC_BASE_URL"
      if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $baseUrl = "https://api.deepseek.com/anthropic"
      }
      $model = Get-EnvValue "AI_TEAM_DEEPSEEK_MODEL"
      if ([string]::IsNullOrWhiteSpace($model)) {
        $model = "deepseek-v4-pro[1m]"
      }
      $content = Invoke-AnthropicMessages -BaseUrl $baseUrl -ApiKey $apiKey -Model $model -SystemPrompt $systemPrompt -UserPrompt $userPrompt -MaxTokens $maxTokens
    }

    $header = "# $provider result`n`nModel budget: $Budget / $maxTokens max output tokens`n`n"
    ($header + $content) | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $results += $resultPath
  } catch {
    $errorText = "# $provider failed`n`n$($_.Exception.Message)"
    $errorText | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $results += $resultPath
  }
}

$summaryPath = Join-Path $runDir "summary.md"
$summaryLines = @()
$summaryLines += "# AI Team Run"
$summaryLines += ""
$summaryLines += "Time: $timestamp"
$summaryLines += "Mode: $Mode"
$summaryLines += "Budget: $Budget"
$summaryLines += "Task file: $taskPath"
$summaryLines += ""
$summaryLines += "Results:"
foreach ($path in $results) {
  $summaryLines += "- $path"
}
$summaryLines += ""
$summaryLines += "Suggested Codex next step: read the result files, then decide whether to apply changes, test, or ask the user."
$summaryLines | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "AI team run finished."
Write-Host "Folder: $runDir"
Write-Host "Summary: $summaryPath"
Write-Host ""

foreach ($path in $results) {
  Write-Host "---- $([System.IO.Path]::GetFileName($path)) ----"
  Get-Content -LiteralPath $path -Encoding UTF8 -TotalCount 28
  Write-Host ""
}

if (-not $NoOpen) {
  try {
    Start-Process explorer.exe $runDir | Out-Null
  } catch {}
}
