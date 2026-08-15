[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$worker = Join-Path $PSScriptRoot "codex-worker.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) "ai-team-worker-usage-$([guid]::NewGuid().ToString('N'))"

function Invoke-UsageParser {
  param([string]$Json, [string]$ErrorText = "", [string]$ProviderLedger = "")
  $jsonPath = Join-Path $fixture "events.json"
  $errorPath = Join-Path $fixture "stderr.txt"
  $textPath = Join-Path $fixture "result.txt"
  $Json | Set-Content -LiteralPath $jsonPath -Encoding UTF8
  $ErrorText | Set-Content -LiteralPath $errorPath -Encoding UTF8
  $raw = & $worker -Worker qwen -Task "usage parser fixture" -UsageParseOnly `
    -UsageParseJsonPath $jsonPath -UsageParseErrorPath $errorPath -UsageParseProviderLedgerPath $ProviderLedger `
    -UsageParseTextPath $textPath -JsonOnly
  return (($raw -join "`n") | ConvertFrom-Json)
}

function Invoke-GrokParser {
  param([string]$Json, [string]$ErrorText = "")
  $jsonPath = Join-Path $fixture "grok-result.json"
  $errorPath = Join-Path $fixture "grok-stderr.txt"
  $textPath = Join-Path $fixture "grok-text.txt"
  $Json | Set-Content -LiteralPath $jsonPath -Encoding UTF8
  $ErrorText | Set-Content -LiteralPath $errorPath -Encoding UTF8
  $raw = & $worker -Worker grok -Task "grok parser fixture" -GrokParseOnly `
    -GrokParseJsonPath $jsonPath -GrokParseErrorPath $errorPath -GrokParseTextPath $textPath -JsonOnly
  return (($raw -join "`n") | ConvertFrom-Json)
}

try {
  New-Item -ItemType Directory -Force -Path $fixture | Out-Null

  # Fixture 1 - legacy whole JSON array (compatibility)
  $reported = Invoke-UsageParser -Json '[{"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":3,"total_tokens":14},"num_turns":2}]'
  if ($reported.availability -ne "reported" -or $reported.total_tokens -ne 14 -or $reported.num_turns -ne 2) {
    throw "Legacy JSON array fixture: expected reported usage."
  }
  Write-Host "Fixture 1 (legacy array): passed"

  # Fixture 2 - newline-delimited stream-json with final result (success)
  $streamSuccessJson = @'
{"type":"assistant","message":{"usage":{"input_tokens":15,"output_tokens":3,"cache_read_tokens":2,"total_tokens":18}}}
{"type":"result","is_error":false,"result":"task done","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":4,"total_tokens":25},"num_turns":1}
'@
  $streamSuccess = Invoke-UsageParser -Json $streamSuccessJson
  if ($streamSuccess.availability -ne "reported" -or $streamSuccess.total_tokens -ne 25 -or $streamSuccess.num_turns -ne 1 -or $streamSuccess.is_error -ne $false) {
    throw "Stream-json success fixture: expected reported usage from final result."
  }
  Write-Host "Fixture 2 (stream-json success): passed"

  # Fixture 3 - truncated stream-json with incremental pre-failure usage recovery
  $recoveredJson = @'
{"type":"assistant","message":{"usage":{"input_tokens":11,"output_tokens":2,"cache_read_input_tokens":4,"total_tokens":13}}}
{"type":"assistant","message":{"usage":{"input_tokens":21,"output_tokens":5,"cache_read_tokens":8,"total_tokens":26}}}
{"type":"error","error":{"message":"turn limit"}}
'@
  $recovered = Invoke-UsageParser -Json $recoveredJson -ErrorText '{"error":{"type":"FatalTurnLimitedError","message":"Reached max session turns"}}'
  if ($recovered.availability -ne "recovered" -or $recovered.input_tokens -ne 32 -or $recovered.output_tokens -ne 7 -or $recovered.cache_read_tokens -ne 12 -or $recovered.total_tokens -ne 39 -or $recovered.num_turns -ne 2 -or $recovered.availability_reason -notmatch "FatalTurnLimitedError" -or -not $recovered.is_error) {
    throw "Truncated stream-json fixture: expected summed provider usage from two pre-failure events."
  }
  Write-Host "Fixture 3 (truncated stream-json recovery): passed"

  # Fixture 4 - no events at all, FatalTurnLimitedError in stderr
  $unavailable = Invoke-UsageParser -Json "" -ErrorText '{"error":{"type":"FatalTurnLimitedError","message":"Reached max session turns"}}'
  if ($unavailable.availability -ne "unavailable" -or $null -ne $unavailable.total_tokens -or $unavailable.availability_reason -notmatch "FatalTurnLimitedError") {
    throw "Expected explicit unavailable usage without fabricated token values."
  }
  Write-Host "Fixture 4 (FatalTurnLimitedError, no events): passed"

  # Fixture 5 - the run-local provider ledger is authoritative and exposes
  # cache-adjusted input, thinking tokens, request count, and API duration.
  $providerLedger = Join-Path $fixture "token-usage.jsonl"
  @'
{"model":"qwen3.7-plus","inputTokens":100,"outputTokens":10,"cachedTokens":60,"thoughtsTokens":3,"totalTokens":110,"apiDurationMs":700}
{"model":"qwen3.7-plus","inputTokens":140,"outputTokens":20,"cachedTokens":100,"thoughtsTokens":5,"totalTokens":160,"apiDurationMs":900}
'@ | Set-Content -LiteralPath $providerLedger -Encoding UTF8
  $ledgerRecovered = Invoke-UsageParser -Json "" -ErrorText '{"error":{"type":"FatalTurnLimitedError"}}' -ProviderLedger $providerLedger
  if ($ledgerRecovered.availability -ne "recovered" -or $ledgerRecovered.input_tokens -ne 240 -or $ledgerRecovered.cache_read_tokens -ne 160 -or $ledgerRecovered.uncached_input_tokens -ne 80 -or $ledgerRecovered.thinking_tokens -ne 8 -or $ledgerRecovered.request_count -ne 2 -or $ledgerRecovered.provider_duration_ms -ne 1600 -or $ledgerRecovered.requests.Count -ne 2) {
    throw "Provider ledger fixture: expected exact summed and per-request usage."
  }
  Write-Host "Fixture 5 (provider ledger recovery): passed"

  Write-Host "Worker usage parser: 5 fixtures passed"

  # Fixture 6 - official Grok Build final JSON shape.
  $grokReported = Invoke-GrokParser -Json '{"text":"done","stopReason":"end_turn","sessionId":"session-fixture","num_turns":3,"usage":{"input_tokens":40,"cache_read_input_tokens":10,"cache_creation_input_tokens":2,"output_tokens":9,"reasoning_tokens":4},"total_cost_usd":0.01,"total_cost_usd_ticks":100000000}'
  if (-not $grokReported.parsed -or $grokReported.total_tokens -ne 61 -or $grokReported.cache_read_tokens -ne 10 -or $grokReported.cache_creation_tokens -ne 2 -or $grokReported.uncached_input_tokens -ne 40 -or $grokReported.thinking_tokens -ne 4 -or $grokReported.num_turns -ne 3 -or $grokReported.actual_cost -ne 0.01 -or $grokReported.actual_cost_ticks -ne 100000000 -or $grokReported.stop_reason -ne "end_turn") {
    throw "Grok Build JSON fixture: expected exact structured usage and cost."
  }
  $grokFailed = Invoke-GrokParser -Json "" -ErrorText "login required"
  if ($grokFailed.parsed -or -not $grokFailed.is_error -or $null -ne $grokFailed.total_tokens) {
    throw "Grok Build failure fixture: usage must remain unavailable."
  }
  $grokRecovered = Invoke-GrokParser -Json '{"type":"error","message":"turn failed","num_turns":1,"usage":{"input_tokens":6,"cache_read_input_tokens":2,"output_tokens":1},"total_cost_usd":0.001}'
  if (-not $grokRecovered.parsed -or -not $grokRecovered.is_error -or $grokRecovered.availability -ne "recovered" -or $grokRecovered.total_tokens -ne 9 -or $grokRecovered.actual_cost -ne 0.001) {
    throw "Grok Build failure fixture: expected frozen failure usage recovery."
  }
  Write-Host "Fixture 6 (Grok Build JSON): passed"

  # Source-level safe-mode assertions (line-based to avoid nested-paren issues)
  $sourcePath = Join-Path $PSScriptRoot "codex-worker.ps1"
  $sourceLines = Get-Content -LiteralPath $sourcePath
  $safeModeCount = @($sourceLines | Select-String -SimpleMatch '"--safe-mode"').Count
  if ($safeModeCount -ne 2) {
    throw "Expected exactly two Qwen --safe-mode arguments, found $safeModeCount."
  }
  $sourceText = $sourceLines -join "`n"
  foreach ($requiredGuidance in @("hard work budget", "one-third of the turns", "Reserve the final 2 turns", "do not create plans or todos")) {
    if (-not $sourceText.Contains($requiredGuidance)) { throw "Missing turn-budget guidance: $requiredGuidance" }
  }
  foreach ($requiredReliabilityText in @("Do not start another large generated file", "complete and validate one allowed file", 'DEEPSEEK_API_KEY', 'ReadAllText($promptPath) | & qwen @deepSeekArgs', 'contextWindowSize = 1000000', '2> $qwenErrorPath')) {
    if (-not $sourceText.Contains($requiredReliabilityText)) { throw "Missing worker reliability behavior: $requiredReliabilityText" }
  }
  if ($sourceText -match '(?i)Get-Command\s+claude|&\s*claude|DeepSeekHarness|DeepSeekMaxBudgetUsd') {
    throw "Claude compatibility code must not remain in the unified Qwen harness worker."
  }
  foreach ($requiredGrokText in @('"--prompt-file"', '"--no-auto-update"', '"--output-format", "json"', '"--sandbox", "workspace"', '"--no-subagents"', 'GrokBuildAuth -eq "account"')) {
    if (-not $sourceText.Contains($requiredGrokText)) { throw "Missing Grok Build safety behavior: $requiredGrokText" }
  }
  if ($sourceText -match '(?i)Get-Content[^\n]*auth\.json|Invoke-RestMethod[^\n]*auth\.json|public proxy|tls.*bypass') {
    throw "Grok Build harness must not read auth sessions or discover/bypass proxies."
  }

  function Test-ArgArrayHasFlag {
    param([string[]]$Lines, [string]$VarName, [string]$Flag)
    $idx = $Lines | Select-String -Pattern ([regex]::Escape($VarName) + '\s*=\s*@\s*\(') | Select-Object -First 1 -ExpandProperty LineNumber
    if (-not $idx) { throw "Could not locate $VarName array in source." }
    for ($i = $idx; $i -le $Lines.Count; $i++) {
      $line = $Lines[$i - 1]
      if ($line -match [regex]::Escape($Flag)) { return $true }
      if ($line -match '^\s+\)\s*$' -and $i -gt $idx) { break }
    }
    return $false
  }

  # 1) $qwenArgs must contain --safe-mode
  if (-not (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$qwenArgs' -Flag '--safe-mode')) {
    throw "`$qwenArgs must contain --safe-mode."
  }
  Write-Host "safe-mode assertion 1: `$qwenArgs has --safe-mode"

  # 2) $deepSeekArgs must contain --safe-mode
  if (-not (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$deepSeekArgs' -Flag '--safe-mode')) {
    throw "`$deepSeekArgs must contain --safe-mode."
  }
  Write-Host "safe-mode assertion 2: `$deepSeekArgs has --safe-mode"

  Write-Host "Worker safe-mode: 2 source-level assertions passed"

  # Source-level stream-json assertions: both Qwen arg arrays use stream-json.
  $streamJsonCount = @($sourceLines | Select-String -SimpleMatch '"stream-json"').Count
  if ($streamJsonCount -ne 2) {
    throw "Expected exactly two Qwen --output-format stream-json arguments, found $streamJsonCount."
  }
  Write-Host "stream-json count assertion: found $streamJsonCount"
  if (-not (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$qwenArgs' -Flag 'stream-json')) {
    throw "`$qwenArgs must use --output-format stream-json."
  }
  Write-Host "stream-json assertion 1: `$qwenArgs uses stream-json"
  if (-not (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$deepSeekArgs' -Flag 'stream-json')) {
    throw "`$deepSeekArgs must use --output-format stream-json."
  }
  Write-Host "stream-json assertion 2: `$deepSeekArgs uses stream-json"
  Write-Host "All tests passed."
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
