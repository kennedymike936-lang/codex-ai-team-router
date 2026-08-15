[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("qwen", "deepseek", "grok")]
  [string]$Worker,

  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$Cwd = (Get-Location).Path,

  [string]$TaskId = "",

  [ValidateRange(1, 2)]
  [int]$Attempt = 1,

  [string[]]$AllowedPath = @(),

  [string]$AllowedPathJson = "",

  [ValidateSet("auto", "default", "yolo", "plan")]
  [string]$Approval = "auto",

  [string]$MaxWallTime = "8m",

  [ValidateRange(2, 12)]
  [int]$MaxSessionTurns = 8,

  [ValidateSet("low", "normal", "deep")]
  [string]$Budget = "low",

  [string]$QwenModel = "auto",

  [string]$DeepSeekModel = "auto",

  [ValidateSet("account", "api_key")]
  [string]$GrokBuildAuth = "account",

  [string]$OutRoot = (Join-Path $env:USERPROFILE ".codex-ai-team\runs"),

  [string]$UsageLedger = (Join-Path $env:USERPROFILE ".codex-ai-team\usage\worker-runs.jsonl"),

  [int]$SummaryLines = 30,

  [int]$SummaryMaxChars = 3000,

  [switch]$JsonOnly,

  [switch]$UsageParseOnly,

  [string]$UsageParseJsonPath = "",

  [string]$UsageParseErrorPath = "",

  [string]$UsageParseProviderLedgerPath = "",

  [string]$UsageParseTextPath = "",

  [switch]$GrokParseOnly,

  [string]$GrokParseJsonPath = "",

  [string]$GrokParseErrorPath = "",

  [string]$GrokParseTextPath = ""
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
  if ((";$env:PATHEXT;") -notmatch ";\.EXE;") {
    $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.CPL"
  }
  $portableGitDirs = @()
  $portableGitRoot = Join-Path $env:LOCALAPPDATA "Programs\PortableGit"
  if (Test-Path -LiteralPath $portableGitRoot) {
    $portableGitDirs = @(Get-ChildItem -LiteralPath $portableGitRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "cmd" })
  }
  $extraDirs = @(
    $env:AI_TEAM_NODE_DIR,
    $env:AI_TEAM_GIT_DIR,
    $env:AI_TEAM_TOOLS_DIR,
    (Join-Path $env:USERPROFILE ".grok\bin"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"),
    (Join-Path $env:ProgramFiles "Git\cmd"),
    (Join-Path $env:APPDATA "npm")
  )
  $extraDirs += @($portableGitDirs)
  $extraDirs = @($extraDirs | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if ($extraDirs.Count -gt 0) {
    $env:Path = ((@($extraDirs) + @($env:Path)) -join ";")
  }
}

function New-RunDir {
  param([string]$Kind)
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dir = Join-Path $OutRoot "$timestamp-$Kind"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Get-AvailableModelIds {
  param([string]$Provider, [string]$BaseUrl, [string]$ApiKey)
  try {
    $modelsUrl = $BaseUrl.TrimEnd("/") + "/models"
    if ($Provider -eq "deepseek") {
      $modelsUrl = ($BaseUrl -replace "/anthropic(?:/v1)?/?$", "").TrimEnd("/") + "/models"
    }
    $response = Invoke-RestMethod -Uri $modelsUrl -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 20
    return @($response.data | ForEach-Object { [string]$_.id } | Where-Object { $_ })
  } catch {
    return @()
  }
}

function Resolve-ValueModel {
  param(
    [string]$Provider,
    [string]$RequestedModel,
    [string]$BudgetTier,
    [string]$BaseUrl,
    [string]$ApiKey
  )
  if ($RequestedModel -and $RequestedModel -ne "auto") { return $RequestedModel }

  $available = @(Get-AvailableModelIds -Provider $Provider -BaseUrl $BaseUrl -ApiKey $ApiKey)
  if ($available.Count -gt 0) {
    $preferredTier = $(if ($BudgetTier -eq "low") { "flash" } elseif ($Provider -eq "qwen") { "plus" } else { "pro" })
    $recognized = @()
    foreach ($modelId in $available) {
      $match = $(if ($Provider -eq "qwen") {
        [regex]::Match($modelId, "^qwen(?<version>\d+(?:\.\d+)?)-(?<tier>flash|plus)(?<snapshot>-\d{4}-\d{2}-\d{2})?$")
      } else {
        [regex]::Match($modelId, "^deepseek-v(?<version>\d+(?:\.\d+)?)-(?<tier>flash|pro)(?<snapshot>-\d{4}-\d{2}-\d{2})?$")
      })
      if ($match.Success) {
        $recognized += [pscustomobject]@{
          Id = $modelId
          Version = [double]$match.Groups["version"].Value
          Tier = $match.Groups["tier"].Value
          StableAlias = [string]::IsNullOrWhiteSpace($match.Groups["snapshot"].Value)
        }
      }
    }
    $selected = @($recognized | Where-Object Tier -eq $preferredTier | Sort-Object Version, StableAlias -Descending | Select-Object -First 1)
    if ($selected.Count -gt 0) { return $selected[0].Id }
    $fallback = @($recognized | Sort-Object Version, StableAlias -Descending | Select-Object -First 1)
    if ($fallback.Count -gt 0) { return $fallback[0].Id }
  }

  if ($Provider -eq "qwen") {
    $candidates = $(if ($BudgetTier -eq "low") { @("qwen3.6-flash", "qwen3.7-plus") } else { @("qwen3.7-plus", "qwen3.6-flash") })
  } else {
    $candidates = $(if ($BudgetTier -eq "low") { @("deepseek-v4-flash", "deepseek-v4-pro") } else { @("deepseek-v4-pro", "deepseek-v4-flash") })
  }
  foreach ($candidate in $candidates) {
    if ($available.Count -eq 0 -or $available -contains $candidate) {
      return $candidate
    }
  }
  return $candidates[0]
}

function Read-QwenProviderUsage {
  param([string]$LedgerPath)

  if ([string]::IsNullOrWhiteSpace($LedgerPath) -or -not (Test-Path -LiteralPath $LedgerPath)) {
    return $null
  }
  $files = @()
  if ((Get-Item -LiteralPath $LedgerPath).PSIsContainer) {
    $files = @(Get-ChildItem -LiteralPath $LedgerPath -Recurse -File -Filter "token-usage-*.jsonl")
  } else {
    $files = @((Get-Item -LiteralPath $LedgerPath))
  }
  $requests = @()
  foreach ($file in $files) {
    foreach ($line in @(Get-Content -LiteralPath $file.FullName -Encoding UTF8)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $event = $line | ConvertFrom-Json } catch { continue }
      if ($null -eq $event.inputTokens -and $null -eq $event.outputTokens) { continue }
      $inputTokens = [long]$(if ($null -ne $event.inputTokens) { $event.inputTokens } else { 0 })
      $cachedTokens = [long]$(if ($null -ne $event.cachedTokens) { $event.cachedTokens } else { 0 })
      $requests += [pscustomobject]@{
        model = [string]$event.model
        input_tokens = $inputTokens
        output_tokens = [long]$(if ($null -ne $event.outputTokens) { $event.outputTokens } else { 0 })
        cache_read_tokens = $cachedTokens
        uncached_input_tokens = [long][math]::Max(0, $inputTokens - $cachedTokens)
        thinking_tokens = [long]$(if ($null -ne $event.thoughtsTokens) { $event.thoughtsTokens } else { 0 })
        total_tokens = [long]$(if ($null -ne $event.totalTokens) { $event.totalTokens } else { 0 })
        provider_duration_ms = [long]$(if ($null -ne $event.apiDurationMs) { $event.apiDurationMs } else { 0 })
      }
    }
  }
  if ($requests.Count -eq 0) { return $null }

  return [pscustomobject]@{
    input_tokens = [long](($requests.input_tokens | Measure-Object -Sum).Sum)
    output_tokens = [long](($requests.output_tokens | Measure-Object -Sum).Sum)
    cache_read_tokens = [long](($requests.cache_read_tokens | Measure-Object -Sum).Sum)
    uncached_input_tokens = [long](($requests.uncached_input_tokens | Measure-Object -Sum).Sum)
    thinking_tokens = [long](($requests.thinking_tokens | Measure-Object -Sum).Sum)
    total_tokens = [long](($requests.total_tokens | Measure-Object -Sum).Sum)
    provider_duration_ms = [long](($requests.provider_duration_ms | Measure-Object -Sum).Sum)
    request_count = [int]$requests.Count
    requests = @($requests)
  }
}

function Convert-QwenJsonOutput {
  param(
    [string]$JsonPath,
    [string]$ErrorPath,
    [string]$ProviderLedgerPath = "",
    [string]$TextPath
  )

  $messages = @()
  $raw = $(if (Test-Path -LiteralPath $JsonPath) { Get-Content -LiteralPath $JsonPath -Raw } else { "" })
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    try {
      $parsed = $raw | ConvertFrom-Json
      $messages = @($parsed | ForEach-Object { $_ })
    } catch {
      foreach ($line in ($raw -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $messages += ($line | ConvertFrom-Json) } catch {}
      }
    }
  }

  $final = $messages | Where-Object { $_.type -eq "result" } | Select-Object -Last 1
  $usageEvents = @($messages | ForEach-Object {
    $payload = $(if ($null -ne $_.usage) { $_.usage } elseif ($null -ne $_.message.usage) { $_.message.usage } else { $null })
    if ($null -ne $payload) { [pscustomobject]@{ event = $_; usage = $payload } }
  })
  $lastUsageEvent = $usageEvents | Select-Object -Last 1
  $recoveredTurns = @($usageEvents | Where-Object {
    ($null -ne $_.usage.input_tokens -and [long]$_.usage.input_tokens -gt 0) -or
    ($null -ne $_.usage.output_tokens -and [long]$_.usage.output_tokens -gt 0) -or
    ($null -ne $_.usage.total_tokens -and [long]$_.usage.total_tokens -gt 0)
  }).Count
  $inputValues = @($usageEvents | ForEach-Object { if ($null -ne $_.usage.input_tokens) { [long]$_.usage.input_tokens } })
  $outputValues = @($usageEvents | ForEach-Object { if ($null -ne $_.usage.output_tokens) { [long]$_.usage.output_tokens } })
  $cacheValues = @($usageEvents | ForEach-Object { if ($null -ne $_.usage.cache_read_input_tokens) { [long]$_.usage.cache_read_input_tokens } elseif ($null -ne $_.usage.cache_read_tokens) { [long]$_.usage.cache_read_tokens } })
  $totalValues = @($usageEvents | ForEach-Object { if ($null -ne $_.usage.total_tokens) { [long]$_.usage.total_tokens } })
  $providerUsage = Read-QwenProviderUsage -LedgerPath $ProviderLedgerPath
  $usage = $(if ($null -ne $providerUsage) {
    $providerUsage
  } elseif ($null -ne $final.usage) {
    $final.usage
  } elseif ($usageEvents.Count -gt 0) {
    [pscustomobject]@{
      input_tokens = $(if ($inputValues.Count -gt 0) { [long](($inputValues | Measure-Object -Sum).Sum) } else { $null })
      output_tokens = $(if ($outputValues.Count -gt 0) { [long](($outputValues | Measure-Object -Sum).Sum) } else { $null })
      cache_read_tokens = $(if ($cacheValues.Count -gt 0) { [long](($cacheValues | Measure-Object -Sum).Sum) } else { $null })
      total_tokens = $(if ($totalValues.Count -gt 0) { [long](($totalValues | Measure-Object -Sum).Sum) } else { $null })
    }
  } else { $null })
  $stderrText = ""
  if (Test-Path -LiteralPath $ErrorPath) {
    $stderrRaw = Get-Content -LiteralPath $ErrorPath -Raw
    $stderrText = $(if ($null -ne $stderrRaw) { $stderrRaw.Trim() } else { "" })
  }

  if ($final) {
    $text = if ($final.is_error) { [string]$final.error.message } else { [string]$final.result }
    if ([string]::IsNullOrWhiteSpace($text)) {
      $text = if ($final.is_error) { "Qwen worker failed without an error message." } else { "Qwen worker completed without a text result." }
    }
    $text | Set-Content -LiteralPath $TextPath -Encoding UTF8
    $availability = $(if ($usage) { "reported" } else { "unavailable" })
    $reason = $(if ($providerUsage) { "Provider request ledger reported exact per-request usage." } elseif ($usage) { "Final result event reported usage." } else { "Final result event did not include usage." })
  } else {
    $failureType = [regex]::Match($stderrText, '"type"\s*:\s*"(?<type>[^"]+)"').Groups["type"].Value
    $reason = $(if ($failureType) {
      "Qwen terminated before a result event ($failureType); CLI usage was not reported."
    } else {
      "Qwen output did not contain a result event; CLI usage was not reported."
    })
    $availability = $(if ($usage) { "recovered" } else { "unavailable" })
    if ($usage) {
      $failureSuffix = $(if ($failureType) { " ($failureType)" } else { "" })
      $reason = "Recovered usage by summing provider-reported structured events before Qwen terminated$failureSuffix without a result event."
      if ($providerUsage) {
        $reason = "Recovered exact per-request usage from the provider ledger after Qwen terminated$failureSuffix without a result event."
      }
    }
    $details = "Failed to parse Qwen JSON output: $reason"
    if (-not [string]::IsNullOrWhiteSpace($stderrText)) { $details += [Environment]::NewLine + $stderrText }
    $details | Set-Content -LiteralPath $TextPath -Encoding UTF8
    $text = $details
  }

  return [pscustomobject]@{
    parsed = [bool]$final
    is_error = $(if ($final) { [bool]$final.is_error } else { $true })
    error_message = $(if ($final -and $final.is_error) { [string]$final.error.message } elseif (-not $final) { $reason } else { "" })
    availability = $availability
    availability_reason = $reason
    input_tokens = $(if ($null -ne $usage.input_tokens) { [long]$usage.input_tokens } else { $null })
    output_tokens = $(if ($null -ne $usage.output_tokens) { [long]$usage.output_tokens } else { $null })
    cache_read_tokens = $(if ($null -ne $usage.cache_read_input_tokens) { [long]$usage.cache_read_input_tokens } elseif ($null -ne $usage.cache_read_tokens) { [long]$usage.cache_read_tokens } else { $null })
    uncached_input_tokens = $(if ($null -ne $usage.uncached_input_tokens) { [long]$usage.uncached_input_tokens } elseif ($null -ne $usage.input_tokens) { [long][math]::Max(0, [long]$usage.input_tokens - [long]$(if ($null -ne $usage.cache_read_tokens) { $usage.cache_read_tokens } elseif ($null -ne $usage.cache_read_input_tokens) { $usage.cache_read_input_tokens } else { 0 })) } else { $null })
    thinking_tokens = $(if ($null -ne $usage.thinking_tokens) { [long]$usage.thinking_tokens } else { $null })
    total_tokens = $(if ($null -ne $usage.total_tokens) { [long]$usage.total_tokens } else { $null })
    num_turns = $(if ($null -ne $final.num_turns) { [int]$final.num_turns } elseif ($null -ne $providerUsage.request_count) { [int]$providerUsage.request_count } elseif ($recoveredTurns -gt 0) { [int]$recoveredTurns } else { $null })
    request_count = $(if ($null -ne $providerUsage.request_count) { [int]$providerUsage.request_count } else { $null })
    requests = $(if ($null -ne $providerUsage.requests) { @($providerUsage.requests) } else { @() })
    provider_duration_ms = $(if ($null -ne $providerUsage.provider_duration_ms) { [long]$providerUsage.provider_duration_ms } elseif ($null -ne $lastUsageEvent.event.provider_duration_ms) { [long]$lastUsageEvent.event.provider_duration_ms } else { $null })
    wall_duration_ms = $(if ($null -ne $final.duration_ms) { [long]$final.duration_ms } elseif ($null -ne $lastUsageEvent.event.duration_ms) { [long]$lastUsageEvent.event.duration_ms } else { $null })
  }
}

function Convert-GrokJsonOutput {
  param(
    [string]$JsonPath,
    [string]$ErrorPath,
    [string]$TextPath
  )

  $raw = $(if (Test-Path -LiteralPath $JsonPath) { Get-Content -LiteralPath $JsonPath -Raw -ErrorAction SilentlyContinue } else { "" })
  $stderrRaw = $(if (Test-Path -LiteralPath $ErrorPath) { Get-Content -LiteralPath $ErrorPath -Raw -ErrorAction SilentlyContinue } else { "" })
  $stderrText = $(if ($null -ne $stderrRaw) { ([string]$stderrRaw).Trim() } else { "" })
  $data = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$raw)) {
    try { $data = ([string]$raw | ConvertFrom-Json) } catch {}
  }

  if ($data -and $data.PSObject.Properties.Name -contains "text") {
    $text = [string]$data.text
    if ([string]::IsNullOrWhiteSpace($text)) { $text = "Grok Build completed without response text." }
    $text | Set-Content -LiteralPath $TextPath -Encoding UTF8
    $usage = $data.usage
    return [pscustomobject]@{
      parsed = $true
      is_error = $false
      error_message = ""
      availability = $(if ($usage) { "reported" } else { "unavailable" })
      availability_reason = $(if ($usage) { "Grok Build final JSON reported usage." } else { "Grok Build completed without usage fields." })
      input_tokens = $(if ($null -ne $usage.input_tokens) { [long]$usage.input_tokens } else { $null })
      output_tokens = $(if ($null -ne $usage.output_tokens) { [long]$usage.output_tokens } else { $null })
      cache_read_tokens = $(if ($null -ne $usage.cache_read_input_tokens) { [long]$usage.cache_read_input_tokens } else { $null })
      cache_creation_tokens = $(if ($null -ne $usage.cache_creation_input_tokens) { [long]$usage.cache_creation_input_tokens } else { $null })
      uncached_input_tokens = $(if ($null -ne $usage.input_tokens) { [long]$usage.input_tokens } else { $null })
      thinking_tokens = $(if ($null -ne $usage.reasoning_tokens) { [long]$usage.reasoning_tokens } else { $null })
      total_tokens = $(if ($null -ne $usage.total_tokens) { [long]$usage.total_tokens } elseif ($null -ne $usage.input_tokens -or $null -ne $usage.output_tokens) { [long]$(0 + $usage.input_tokens + $usage.cache_read_input_tokens + $usage.cache_creation_input_tokens + $usage.output_tokens) } else { $null })
      num_turns = $(if ($null -ne $data.num_turns) { [int]$data.num_turns } else { $null })
      request_count = $(if ($null -ne $data.num_turns) { [int]$data.num_turns } else { $null })
      requests = @()
      provider_duration_ms = $null
      wall_duration_ms = $null
      actual_cost = $(if ($null -ne $data.total_cost_usd) { [decimal]$data.total_cost_usd } else { $null })
      actual_cost_ticks = $(if ($null -ne $data.total_cost_usd_ticks) { [long]$data.total_cost_usd_ticks } else { $null })
      models = $(if ($data.modelUsage) { @($data.modelUsage.PSObject.Properties.Name) } else { @() })
      session_id = $(if ($data.sessionId) { [string]$data.sessionId } else { $null })
      stop_reason = $(if ($data.stopReason) { [string]$data.stopReason } else { $null })
    }
  }

  $message = $(if ($data -and $data.message) { [string]$data.message } elseif (-not [string]::IsNullOrWhiteSpace($stderrText)) { $stderrText } else { "Grok Build did not return a valid final JSON result." })
  $failureUsage = $(if ($data) { $data.usage } else { $null })
  "Grok Build failed: $message" | Set-Content -LiteralPath $TextPath -Encoding UTF8
  return [pscustomobject]@{
    parsed = [bool]$data
    is_error = $true
    error_message = $message
    availability = $(if ($failureUsage) { "recovered" } else { "unavailable" })
    availability_reason = $(if ($failureUsage) { "Grok Build failure JSON reported frozen usage." } else { "Grok Build did not report verifiable usage." })
    input_tokens = $(if ($null -ne $failureUsage.input_tokens) { [long]$failureUsage.input_tokens } else { $null })
    output_tokens = $(if ($null -ne $failureUsage.output_tokens) { [long]$failureUsage.output_tokens } else { $null })
    cache_read_tokens = $(if ($null -ne $failureUsage.cache_read_input_tokens) { [long]$failureUsage.cache_read_input_tokens } else { $null })
    cache_creation_tokens = $(if ($null -ne $failureUsage.cache_creation_input_tokens) { [long]$failureUsage.cache_creation_input_tokens } else { $null })
    uncached_input_tokens = $(if ($null -ne $failureUsage.input_tokens) { [long]$failureUsage.input_tokens } else { $null })
    thinking_tokens = $(if ($null -ne $failureUsage.reasoning_tokens) { [long]$failureUsage.reasoning_tokens } else { $null })
    total_tokens = $(if ($null -ne $failureUsage.total_tokens) { [long]$failureUsage.total_tokens } elseif ($failureUsage) { [long]$(0 + $failureUsage.input_tokens + $failureUsage.cache_read_input_tokens + $failureUsage.cache_creation_input_tokens + $failureUsage.output_tokens) } else { $null })
    num_turns = $(if ($null -ne $data.num_turns) { [int]$data.num_turns } else { $null })
    request_count = $(if ($null -ne $data.num_turns) { [int]$data.num_turns } else { $null })
    requests = @()
    provider_duration_ms = $null
    wall_duration_ms = $null
    actual_cost = $(if ($null -ne $data.total_cost_usd) { [decimal]$data.total_cost_usd } else { $null })
    actual_cost_ticks = $(if ($null -ne $data.total_cost_usd_ticks) { [long]$data.total_cost_usd_ticks } else { $null })
    models = $(if ($data.modelUsage) { @($data.modelUsage.PSObject.Properties.Name) } else { @() })
    session_id = $null
    stop_reason = $null
  }
}

if ($UsageParseOnly) {
  if ([string]::IsNullOrWhiteSpace($UsageParseJsonPath) -or [string]::IsNullOrWhiteSpace($UsageParseTextPath)) {
    throw "UsageParseOnly requires UsageParseJsonPath and UsageParseTextPath."
  }
  Convert-QwenJsonOutput -JsonPath $UsageParseJsonPath -ErrorPath $UsageParseErrorPath -ProviderLedgerPath $UsageParseProviderLedgerPath -TextPath $UsageParseTextPath |
    ConvertTo-Json -Compress -Depth 8
  return
}

if ($GrokParseOnly) {
  if ([string]::IsNullOrWhiteSpace($GrokParseJsonPath) -or [string]::IsNullOrWhiteSpace($GrokParseTextPath)) {
    throw "GrokParseOnly requires GrokParseJsonPath and GrokParseTextPath."
  }
  Convert-GrokJsonOutput -JsonPath $GrokParseJsonPath -ErrorPath $GrokParseErrorPath -TextPath $GrokParseTextPath |
    ConvertTo-Json -Compress -Depth 8
  return
}

function Get-EstimatedCostCny {
  param(
    [string]$Provider,
    [string]$Model,
    $Metrics
  )

  if (-not $Metrics -or $null -eq $Metrics.input_tokens -or $null -eq $Metrics.output_tokens) {
    return $null
  }

  $price = switch ("$Provider/$Model") {
    "qwen/qwen3.6-flash" { @(1.2, 7.2); break }
    "qwen/qwen3.7-plus" { @(2.0, 8.0); break }
    "deepseek/deepseek-v4-flash" { @(1.0, 2.0); break }
    "deepseek/deepseek-v4-pro" { @(3.0, 6.0); break }
    default { $null }
  }
  if (-not $price) { return $null }

  $cost = (([long]$Metrics.input_tokens * $price[0]) + ([long]$Metrics.output_tokens * $price[1])) / 1000000
  return [math]::Round($cost, 8)
}

function Get-GitFileState {
  param([string]$Root)

  $state = @{}
  $previousErrorAction = $ErrorActionPreference
  Push-Location $Root
  try {
    $ErrorActionPreference = "SilentlyContinue"
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) { return $null }
    $paths = @(git ls-files --cached --others --exclude-standard | Where-Object { $_ })
    foreach ($path in $paths) {
      $absolutePath = Join-Path $Root $path
      if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        $state[$path] = "<missing>"
        continue
      }
      try {
        $item = Get-Item -LiteralPath $absolutePath
        if ($item.Length -gt 10MB) {
          $state[$path] = "meta:$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
        } else {
          $state[$path] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash
        }
      } catch {
        $state[$path] = "<unreadable>"
      }
    }
  } finally {
    $ErrorActionPreference = $previousErrorAction
    Pop-Location
  }
  return ,$state
}

function Compare-GitFileState {
  param($Before, $After)
  if ($null -eq $Before -or $null -eq $After) { return @() }
  $keys = @($Before.Keys) + @($After.Keys) | Select-Object -Unique
  return @($keys | Where-Object {
    (-not $Before.ContainsKey($_)) -or
    (-not $After.ContainsKey($_)) -or
    $Before[$_] -ne $After[$_]
  } | Sort-Object)
}

if (-not (Test-Path -LiteralPath $Cwd)) {
  throw "Cwd does not exist: $Cwd"
}
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path
if (-not [string]::IsNullOrWhiteSpace($AllowedPathJson)) {
  $parsedAllowedPaths = $AllowedPathJson | ConvertFrom-Json
  $AllowedPath = @($parsedAllowedPaths | ForEach-Object { [string]$_ })
}

Add-ToolPath
$beforeWorkspaceState = Get-GitFileState -Root $Cwd
$runDir = New-RunDir -Kind $Worker
if ([string]::IsNullOrWhiteSpace($TaskId)) {
  $TaskId = "task-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
}
$taskPath = Join-Path $runDir "task.txt"
$resultPath = Join-Path $runDir "result.txt"
$structuredResultPath = Join-Path $runDir "qwen-result.json"
$qwenErrorPath = Join-Path $runDir "qwen-stderr.txt"
$grokResultPath = Join-Path $runDir "grok-result.json"
$grokErrorPath = Join-Path $runDir "grok-stderr.txt"
$summaryPath = Join-Path $runDir "summary.txt"
$metaPath = Join-Path $runDir "meta.txt"
$workerResultPath = Join-Path $runDir "worker-result.json"

$Task | Set-Content -LiteralPath $taskPath -Encoding UTF8

$workerPrompt = @"
You are a background worker called by Codex, who is the marshal and final reviewer.
Do useful work directly when your tool mode allows it. Keep the task tightly scoped.
Prefer making concrete progress over long discussion.
This is attempt $Attempt of at most 2. If this is attempt 2, fix only the named failed checks.
Your entire session is capped at $MaxSessionTurns assistant turns. Treat this as a hard work budget, not a target.
Spend no more than one-third of the turns on inspection, then make the smallest sufficient change.
Reserve the final 2 turns for one focused validation command and the final report. Stop as soon as both pass.
Your wall-clock budget is $MaxWallTime. Do not start another large generated file after roughly 75% of that budget; finish the current file and leave an exact partial handoff instead.
For tasks with multiple large output files, complete and validate one allowed file before starting the next. Preserve useful partial work when the deadline is close.
For bounded tasks, do not create plans or todos, spawn agents, use computer control, or re-read unchanged files.
Combine related reads and checks into one tool call when practical.
Do not touch secrets, payment data, accounts, unrelated user files, drivers, registry, or system settings unless the user task explicitly asks for it.
Do not run long downloads or installations unless the task explicitly asks for that.
Allowed paths: $(if ($AllowedPath.Count -gt 0) { $AllowedPath -join ', ' } else { 'the task-relevant files inside the current workspace' }).
Do not modify files outside the allowed paths.
At the end, report:
- what you changed or produced
- exact file paths changed
- commands/tests run
- blockers or risks for Codex to handle

Task from Codex:
$Task
"@
$promptPath = Join-Path $runDir "worker-prompt.txt"
[System.IO.File]::WriteAllText($promptPath, $workerPrompt, (New-Object System.Text.UTF8Encoding($false)))

$meta = @()
$meta += "TaskId: $TaskId"
$meta += "Attempt: $Attempt"
$meta += "Worker: $Worker"
$meta += "Cwd: $Cwd"
$meta += "RunDir: $runDir"
$meta += "Approval: $Approval"
$meta += "Budget: $Budget"
$harnessName = $(if ($Worker -eq "grok") { "grok-build" } else { "qwen" })
$meta += "Harness: $harnessName"
$meta += "MaxWallTime: $MaxWallTime"
$meta += "MaxSessionTurns: $MaxSessionTurns"
$meta += "AllowedPath: $($AllowedPath -join ', ')"
$meta | Set-Content -LiteralPath $metaPath -Encoding UTF8

$workerExitCode = $null
$workerError = ""
$selectedModel = ""
$qwenMetrics = $null
$grokMetrics = $null
$workerStartedAt = Get-Date
if ($Approval -eq "yolo") {
  $env:QWEN_CODE_SUPPRESS_YOLO_WARNING = "1"
}
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
    $selectedModel = Resolve-ValueModel -Provider "qwen" -RequestedModel $QwenModel -BudgetTier $Budget -BaseUrl $qwenBaseUrl -ApiKey $openaiKey
    # Keep each worker independent from the user's global Qwen extensions,
    # MCP servers, history, and settings. The worker prompt already carries
    # the bounded task contract, so inherited customizations only add tokens
    # and make runs less deterministic.
    $qwenHome = Join-Path $runDir "qwen-home"
    New-Item -ItemType Directory -Force -Path $qwenHome | Out-Null
    $env:QWEN_HOME = $qwenHome
    $qwenSettings = [ordered]@{
      security = [ordered]@{ auth = [ordered]@{ selectedType = "openai" } }
      model = [ordered]@{ name = $selectedModel }
    }
    $settingsPath = Join-Path $qwenHome "settings.json"
    [System.IO.File]::WriteAllText($settingsPath, ($qwenSettings | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

    $qwenArgs = @(
      # Keep the command line short on Windows. The full worker prompt is
      # streamed through stdin below; this small value selects headless mode.
      "--prompt", "Follow the complete task instructions provided on standard input.",
      "--auth-type", "openai",
      "--model", $selectedModel,
      "--openai-base-url", $env:OPENAI_BASE_URL,
      "--approval-mode", $Approval,
      "--max-wall-time", $MaxWallTime,
      "--max-session-turns", ([string]$MaxSessionTurns),
      "--safe-mode",
      "--output-format", "stream-json"
    )
    $previousErrorAction = $ErrorActionPreference
    try {
      # Windows PowerShell promotes native stderr from the qwen.ps1 shim to
      # ErrorRecord objects. With Stop, a JSON diagnostic is truncated to its
      # first character (usually "{") before we can inspect the exit code and
      # structured output below.
      $ErrorActionPreference = "Continue"
      [System.IO.File]::ReadAllText($promptPath) | & qwen @qwenArgs 1> $structuredResultPath 2> $qwenErrorPath
      $workerExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    $qwenMetrics = Convert-QwenJsonOutput -JsonPath $structuredResultPath -ErrorPath $qwenErrorPath -ProviderLedgerPath (Join-Path $qwenHome "usage") -TextPath $resultPath
    if (-not $qwenMetrics) {
      $workerExitCode = 1
      $workerError = "Qwen structured output could not be parsed."
    } elseif ($qwenMetrics.is_error) {
      $workerError = $qwenMetrics.error_message
    }
  }

  if ($Worker -eq "deepseek") {
    $apiKey = Get-EnvValue "DEEPSEEK_API_KEY"
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      $apiKey = Get-EnvValue "ANTHROPIC_API_KEY"
    }
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      $apiKey = Get-EnvValue "ANTHROPIC_AUTH_TOKEN"
    }
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      throw "DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN is not configured."
    }

    $deepSeekBaseUrl = Get-EnvValue "DEEPSEEK_MCP_BASE_URL"
    if ([string]::IsNullOrWhiteSpace($deepSeekBaseUrl)) {
      $deepSeekBaseUrl = Get-EnvValue "ANTHROPIC_BASE_URL"
    }
    if ([string]::IsNullOrWhiteSpace($deepSeekBaseUrl)) {
      $deepSeekBaseUrl = "https://api.deepseek.com/anthropic"
    }
    $selectedModel = Resolve-ValueModel -Provider "deepseek" -RequestedModel $DeepSeekModel -BudgetTier $Budget -BaseUrl $deepSeekBaseUrl -ApiKey $apiKey
    $deepSeekOpenAiBase = ($deepSeekBaseUrl -replace "/anthropic(?:/v1)?/?$", "").TrimEnd("/")
    $env:OPENAI_API_KEY = $apiKey
    $env:OPENAI_BASE_URL = $deepSeekOpenAiBase
    $qwenHome = Join-Path $runDir "qwen-home"
    New-Item -ItemType Directory -Force -Path $qwenHome | Out-Null
    $env:QWEN_HOME = $qwenHome
    $qwenSettings = [ordered]@{
      modelProviders = [ordered]@{
        openai = @([ordered]@{
          id = $selectedModel
          name = "$selectedModel (DeepSeek auto)"
          envKey = "OPENAI_API_KEY"
          baseUrl = $deepSeekOpenAiBase
          generationConfig = [ordered]@{
            contextWindowSize = 1000000
            timeout = 120000
            samplingParams = [ordered]@{ max_tokens = 8192 }
          }
        })
      }
      security = [ordered]@{ auth = [ordered]@{ selectedType = "openai" } }
      model = [ordered]@{ name = $selectedModel }
    }
    $settingsPath = Join-Path $qwenHome "settings.json"
    $settingsJson = $qwenSettings | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($settingsPath, $settingsJson, (New-Object System.Text.UTF8Encoding($false)))
    $deepSeekArgs = @(
      # Avoid Windows command-line truncation for long task and Scout Pack
      # context. Qwen Code appends piped stdin to this headless prompt.
      "--prompt", "Follow the complete task instructions provided on standard input.",
      "--auth-type", "openai",
      "--model", $selectedModel,
      "--approval-mode", $Approval,
      "--max-wall-time", $MaxWallTime,
      "--max-session-turns", ([string]$MaxSessionTurns),
      "--safe-mode",
      "--output-format", "stream-json"
    )
    $previousErrorAction = $ErrorActionPreference
    try {
      # Preserve native stderr for the parser instead of allowing Windows
      # PowerShell to promote advisory output into a terminating ErrorRecord.
      $ErrorActionPreference = "Continue"
      [System.IO.File]::ReadAllText($promptPath) | & qwen @deepSeekArgs 1> $structuredResultPath 2> $qwenErrorPath
      $workerExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    $qwenMetrics = Convert-QwenJsonOutput -JsonPath $structuredResultPath -ErrorPath $qwenErrorPath -ProviderLedgerPath (Join-Path $qwenHome "usage") -TextPath $resultPath
    if (-not $qwenMetrics) {
      $workerExitCode = 1
      $workerError = "Qwen structured output could not be parsed."
    } elseif ($qwenMetrics.is_error) {
      $workerError = $qwenMetrics.error_message
    }
  }

  if ($Worker -eq "grok") {
    $grokCommand = Get-Command grok -ErrorAction SilentlyContinue
    if (-not $grokCommand) {
      $grokFallback = Join-Path $env:USERPROFILE ".grok\bin\grok.exe"
      if (Test-Path -LiteralPath $grokFallback -PathType Leaf) {
        $grokCommand = Get-Item -LiteralPath $grokFallback
      }
    }
    if (-not $grokCommand) {
      throw "Official Grok Build CLI was not found. Install it from https://docs.x.ai/build/cli/installation."
    }
    $grokExecutable = $(if ($grokCommand.Source) { $grokCommand.Source } elseif ($grokCommand.Path) { $grokCommand.Path } else { $grokCommand.FullName })

    $selectedModel = "grok-build-auto"
    $grokArgs = @(
      "--no-auto-update",
      "--prompt-file", $promptPath,
      "--cwd", $Cwd,
      "--output-format", "json",
      "--max-turns", ([string]$MaxSessionTurns),
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      "--sandbox", "workspace",
      "--no-plan"
    )
    if ($Approval -eq "yolo") {
      $grokArgs += "--always-approve"
    } else {
      $grokArgs += @("--permission-mode", "dontAsk")
    }

    # Account auth is the default so a free Grok Build allowance cannot
    # silently fall through to paid API billing. API-key auth must be chosen
    # explicitly by the caller.
    $previousXaiKey = [Environment]::GetEnvironmentVariable("XAI_API_KEY", "Process")
    $previousHttpProxy = [Environment]::GetEnvironmentVariable("HTTP_PROXY", "Process")
    $previousHttpsProxy = [Environment]::GetEnvironmentVariable("HTTPS_PROXY", "Process")
    $grokIsolationEnv = @(
      "GROK_CURSOR_SKILLS_ENABLED",
      "GROK_CLAUDE_SKILLS_ENABLED",
      "GROK_CURSOR_MCPS_ENABLED",
      "GROK_CLAUDE_MCPS_ENABLED"
    )
    $previousGrokIsolationEnv = @{}
    try {
      foreach ($name in $grokIsolationEnv) {
        $previousGrokIsolationEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, "false", "Process")
      }
      if ($GrokBuildAuth -eq "account") {
        [Environment]::SetEnvironmentVariable("XAI_API_KEY", $null, "Process")
      } else {
        $grokApiKey = Get-EnvValue "XAI_API_KEY"
        if ([string]::IsNullOrWhiteSpace($grokApiKey)) {
          throw "Grok Build api_key auth was selected, but XAI_API_KEY is not configured."
        }
        [Environment]::SetEnvironmentVariable("XAI_API_KEY", $grokApiKey, "Process")
      }

      $trustedProxy = Get-EnvValue "AI_TEAM_TRUSTED_PROXY_URL"
      if (-not [string]::IsNullOrWhiteSpace($trustedProxy)) {
        if ([string]::IsNullOrWhiteSpace($env:HTTP_PROXY)) { $env:HTTP_PROXY = $trustedProxy }
        if ([string]::IsNullOrWhiteSpace($env:HTTPS_PROXY)) { $env:HTTPS_PROXY = $trustedProxy }
      }

      $previousErrorAction = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        & $grokExecutable @grokArgs 1> $grokResultPath 2> $grokErrorPath
        $workerExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorAction
      }
    } finally {
      [Environment]::SetEnvironmentVariable("XAI_API_KEY", $previousXaiKey, "Process")
      [Environment]::SetEnvironmentVariable("HTTP_PROXY", $previousHttpProxy, "Process")
      [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $previousHttpsProxy, "Process")
      foreach ($name in $grokIsolationEnv) {
        [Environment]::SetEnvironmentVariable($name, $previousGrokIsolationEnv[$name], "Process")
      }
    }

    $grokMetrics = Convert-GrokJsonOutput -JsonPath $grokResultPath -ErrorPath $grokErrorPath -TextPath $resultPath
    if ($grokMetrics -and @($grokMetrics.models).Count -gt 0) {
      $selectedModel = (@($grokMetrics.models) -join ",")
    }
    if (-not $grokMetrics -or -not $grokMetrics.parsed -or $grokMetrics.is_error) {
      if ($workerExitCode -eq 0) { $workerExitCode = 1 }
      $workerError = $(if ($grokMetrics) { $grokMetrics.error_message } else { "Grok Build structured output could not be parsed." })
    }
  }
} catch {
  $workerExitCode = 1
  $workerError = $_.Exception.Message
  "Worker failed before completing the task: $workerError" | Set-Content -LiteralPath $resultPath -Encoding UTF8
} finally {
  Pop-Location
}

if (-not $JsonOnly) {
  Write-Host ""
  Write-Host "Worker finished."
  Write-Host "RunDir: $runDir"
  Write-Host "Result: $resultPath"
  Write-Host "Summary: $summaryPath"
  Write-Host "WorkerResult: $workerResultPath"
  Write-Host "Model: $selectedModel"
  if ($null -ne $workerExitCode) {
    Write-Host "ExitCode: $workerExitCode"
  }
  Write-Host ""
  Write-Host "---- compact summary ----"
}
if (Test-Path -LiteralPath $resultPath) {
  $summaryText = ((Get-Content -LiteralPath $resultPath -Tail $SummaryLines) -join [Environment]::NewLine).Trim()
  if ($summaryText.Length -gt $SummaryMaxChars) {
    $summaryText = "[truncated to final $SummaryMaxChars characters]" + [Environment]::NewLine + $summaryText.Substring($summaryText.Length - $SummaryMaxChars)
  }
  $summaryText | Set-Content -LiteralPath $summaryPath -Encoding UTF8
  if (-not $JsonOnly) { Write-Host $summaryText }
} else {
  $summaryText = "Worker produced no result file."
  $summaryText | Set-Content -LiteralPath $summaryPath -Encoding UTF8
}

$changedFiles = @()
$pushedForFallback = $false
try {
  $afterWorkspaceState = Get-GitFileState -Root $Cwd
  if ($null -ne $beforeWorkspaceState -and $null -ne $afterWorkspaceState) {
    $changedFiles = @(Compare-GitFileState -Before $beforeWorkspaceState -After $afterWorkspaceState)
  } else {
  Push-Location $Cwd
  $pushedForFallback = $true
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  git rev-parse --is-inside-work-tree *> $null
  $insideGitExit = $LASTEXITCODE
  if ($insideGitExit -eq 0) {
    git rev-parse --verify HEAD *> $null
    $headExit = $LASTEXITCODE
    if ($headExit -eq 0) {
      $changedFiles = @(git diff HEAD --name-only)
    } else {
      $changedFiles = @(git ls-files --cached)
    }
    $changedFiles += @(git ls-files --others --exclude-standard)
    $changedFiles = @($changedFiles | Where-Object { $_ } | Select-Object -Unique)
  }
  }
} catch {
  $changedFiles = @()
} finally {
  if ($null -ne $previousErrorAction) { $ErrorActionPreference = $previousErrorAction }
  if ($pushedForFallback) { Pop-Location }
}

$workerStatus = $(if ($workerExitCode -eq 0) { "success" } else { "failed" })
$workerMetrics = $(if ($Worker -eq "grok") { $grokMetrics } else { $qwenMetrics })
$structuredArtifact = $(if ($Worker -eq "grok") { $grokResultPath } else { $structuredResultPath })
$stderrArtifact = $(if ($Worker -eq "grok") { $grokErrorPath } else { $qwenErrorPath })
$workerResult = [ordered]@{
  schema_version = "1.0"
  task_id = $TaskId
  task = $Task
  attempt = $Attempt
  worker = $Worker
  harness = $harnessName
  model = $selectedModel
  budget = $Budget
  status = $workerStatus
  exit_code = $workerExitCode
  error = $workerError
  summary = $summaryText
  usage = $(if ($workerMetrics) { [ordered]@{
    availability = $workerMetrics.availability
    reason = $workerMetrics.availability_reason
    input_tokens = $workerMetrics.input_tokens
    output_tokens = $workerMetrics.output_tokens
    cache_read_tokens = $workerMetrics.cache_read_tokens
    cache_creation_tokens = $(if ($null -ne $workerMetrics.cache_creation_tokens) { $workerMetrics.cache_creation_tokens } else { $null })
    uncached_input_tokens = $workerMetrics.uncached_input_tokens
    thinking_tokens = $workerMetrics.thinking_tokens
    total_tokens = $workerMetrics.total_tokens
    num_turns = $workerMetrics.num_turns
    request_count = $workerMetrics.request_count
    provider_duration_ms = $workerMetrics.provider_duration_ms
    wall_duration_ms = $workerMetrics.wall_duration_ms
    actual_cost = $(if ($null -ne $workerMetrics.actual_cost) { $workerMetrics.actual_cost } else { $null })
    actual_cost_ticks = $(if ($null -ne $workerMetrics.actual_cost_ticks) { $workerMetrics.actual_cost_ticks } else { $null })
    session_id = $(if ($null -ne $workerMetrics.session_id) { $workerMetrics.session_id } else { $null })
    stop_reason = $(if ($null -ne $workerMetrics.stop_reason) { $workerMetrics.stop_reason } else { $null })
    requests = @($workerMetrics.requests)
  } } else { $null })
  changed_files = @($changedFiles)
  allowed_paths = @($AllowedPath)
  artifacts = [ordered]@{
    run_dir = $runDir
    full_result = $resultPath
    structured_result = $(if (Test-Path -LiteralPath $structuredArtifact) { $structuredArtifact } else { $null })
    stderr = $(if (Test-Path -LiteralPath $stderrArtifact) { $stderrArtifact } else { $null })
    summary = $summaryPath
    metadata = $metaPath
    worker_result = $workerResultPath
  }
}
$workerResult | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $workerResultPath -Encoding UTF8

$workerEndedAt = Get-Date
$estimatedCostCny = $(if ($Worker -eq "grok") { $null } else { Get-EstimatedCostCny -Provider $Worker -Model $selectedModel -Metrics $workerMetrics })
$usageDir = Split-Path -Parent $UsageLedger
if ($usageDir) { New-Item -ItemType Directory -Force -Path $usageDir | Out-Null }
$ledgerEvent = [ordered]@{
  schema_version = "1.0"
  timestamp = $workerEndedAt.ToUniversalTime().ToString("o")
  task_id = $TaskId
  provider = $Worker
  model = $selectedModel
  budget = $Budget
  success = ($workerStatus -eq "success")
  latency_ms = [math]::Round(($workerEndedAt - $workerStartedAt).TotalMilliseconds)
  usage_availability = $(if ($workerMetrics) { $workerMetrics.availability } else { "unavailable" })
  usage_reason = $(if ($workerMetrics) { $workerMetrics.availability_reason } else { "Selected CLI harness did not expose structured usage." })
  input_tokens = $(if ($workerMetrics) { $workerMetrics.input_tokens } else { $null })
  output_tokens = $(if ($workerMetrics) { $workerMetrics.output_tokens } else { $null })
  cache_read_tokens = $(if ($workerMetrics) { $workerMetrics.cache_read_tokens } else { $null })
  cache_creation_tokens = $(if ($workerMetrics -and $null -ne $workerMetrics.cache_creation_tokens) { $workerMetrics.cache_creation_tokens } else { $null })
  uncached_input_tokens = $(if ($workerMetrics) { $workerMetrics.uncached_input_tokens } else { $null })
  thinking_tokens = $(if ($workerMetrics) { $workerMetrics.thinking_tokens } else { $null })
  total_tokens = $(if ($workerMetrics) { $workerMetrics.total_tokens } else { $null })
  num_turns = $(if ($workerMetrics) { $workerMetrics.num_turns } else { $null })
  request_count = $(if ($workerMetrics) { $workerMetrics.request_count } else { $null })
  provider_duration_ms = $(if ($workerMetrics) { $workerMetrics.provider_duration_ms } else { $null })
  requests = $(if ($workerMetrics) { @($workerMetrics.requests) } else { @() })
  actual_cost = $(if ($workerMetrics -and $null -ne $workerMetrics.actual_cost) { $workerMetrics.actual_cost } else { $null })
  actual_cost_ticks = $(if ($workerMetrics -and $null -ne $workerMetrics.actual_cost_ticks) { $workerMetrics.actual_cost_ticks } else { $null })
  estimated_cost_cny = $estimatedCostCny
  cost_note = $(if ($Worker -eq "grok" -and $workerMetrics -and $null -ne $workerMetrics.actual_cost) { "Grok Build CLI reported the cost; the account billing page remains authoritative" } elseif ($workerMetrics -and $workerMetrics.availability -eq "reported") { "Exact provider token usage; catalog estimate does not apply provider-specific cache discounts, and provider billing is authoritative" } elseif ($workerMetrics -and $workerMetrics.availability -eq "recovered") { "Usage recovered from provider records after failure; provider billing remains authoritative" } else { "CLI usage unavailable; no token or cost value was fabricated" })
  harness = $harnessName
  worker_result = $workerResultPath
}
Add-Content -LiteralPath $UsageLedger -Value ($ledgerEvent | ConvertTo-Json -Compress) -Encoding UTF8

if ($JsonOnly) {
  Get-Content -LiteralPath $workerResultPath -Raw -Encoding UTF8 |
    ConvertFrom-Json | ConvertTo-Json -Compress -Depth 5
}
