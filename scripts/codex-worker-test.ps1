[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$worker = Join-Path $PSScriptRoot "codex-worker.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) "ai-team-worker-usage-$([guid]::NewGuid().ToString('N'))"

function Invoke-UsageParser {
  param([string]$Json, [string]$ErrorText = "")
  $jsonPath = Join-Path $fixture "events.json"
  $errorPath = Join-Path $fixture "stderr.txt"
  $textPath = Join-Path $fixture "result.txt"
  $Json | Set-Content -LiteralPath $jsonPath -Encoding UTF8
  $ErrorText | Set-Content -LiteralPath $errorPath -Encoding UTF8
  $raw = & $worker -Worker qwen -Task "usage parser fixture" -UsageParseOnly `
    -UsageParseJsonPath $jsonPath -UsageParseErrorPath $errorPath -UsageParseTextPath $textPath -JsonOnly
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

  Write-Host "Worker usage parser: 4 fixtures passed"

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

  # 3) $claudeArgs must NOT contain --safe-mode
  if (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$claudeArgs' -Flag '--safe-mode') {
    throw "`$claudeArgs must NOT contain --safe-mode."
  }
  Write-Host "safe-mode assertion 3: `$claudeArgs lacks --safe-mode"

  Write-Host "Worker safe-mode: 3 source-level assertions passed"

  # Source-level stream-json assertions: both Qwen arg arrays use stream-json,
  # Claude arg array does not.
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
  if (Test-ArgArrayHasFlag -Lines $sourceLines -VarName '$claudeArgs' -Flag 'stream-json') {
    throw "`$claudeArgs must NOT use stream-json."
  }
  Write-Host "stream-json assertion 3: `$claudeArgs lacks stream-json"

  Write-Host "All tests passed."
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
