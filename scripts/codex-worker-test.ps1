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

  $reported = Invoke-UsageParser -Json '[{"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":3,"total_tokens":14},"num_turns":2}]'
  if ($reported.availability -ne "reported" -or $reported.total_tokens -ne 14 -or $reported.num_turns -ne 2) {
    throw "Expected exact usage from a final result event."
  }

  $recoveredJson = @'
{"type":"assistant","usage":{"input_tokens":21,"output_tokens":5,"cache_read_tokens":8,"total_tokens":26},"num_turns":3}
{"type":"error","error":{"message":"turn limit"}}
'@
  $recovered = Invoke-UsageParser -Json $recoveredJson
  if ($recovered.availability -ne "recovered" -or $recovered.total_tokens -ne 26 -or -not $recovered.is_error) {
    throw "Expected usage recovery from the last pre-failure structured event."
  }

  $unavailable = Invoke-UsageParser -Json "" -ErrorText '{"error":{"type":"FatalTurnLimitedError","message":"Reached max session turns"}}'
  if ($unavailable.availability -ne "unavailable" -or $null -ne $unavailable.total_tokens -or $unavailable.availability_reason -notmatch "FatalTurnLimitedError") {
    throw "Expected explicit unavailable usage without fabricated token values."
  }

  Write-Host "Worker usage parser: 3 scenarios passed"

  # Source-level safe-mode assertions (line-based to avoid nested-paren issues)
  $sourcePath = Join-Path $PSScriptRoot "codex-worker.ps1"
  $sourceLines = Get-Content -LiteralPath $sourcePath
  $safeModeCount = @($sourceLines | Select-String -SimpleMatch '"--safe-mode"').Count
  if ($safeModeCount -ne 2) {
    throw "Expected exactly two Qwen --safe-mode arguments, found $safeModeCount."
  }

  function Test-ArgArrayHasSafeMode {
    param([string[]]$Lines, [string]$VarName)
    $idx = $Lines | Select-String -Pattern ([regex]::Escape($VarName) + '\s*=\s*@\s*\(') | Select-Object -First 1 -ExpandProperty LineNumber
    if (-not $idx) { throw "Could not locate $VarName array in source." }
    # Scan forward from array start until closing ) at same or lesser indent
    for ($i = $idx; $i -lt $Lines.Count; $i++) {
      $line = $Lines[$i - 1]
      if ($line -match '--safe-mode') { return $true }
      # Closing paren on its own line (array terminator)
      if ($line -match '^\s+\)\s*$' -and $i -gt $idx) { break }
    }
    return $false
  }

  # 1) $qwenArgs must contain --safe-mode
  if (-not (Test-ArgArrayHasSafeMode -Lines $sourceLines -VarName '$qwenArgs')) {
    throw "`$qwenArgs must contain --safe-mode."
  }
  Write-Host "safe-mode assertion 1: `$qwenArgs has --safe-mode"

  # 2) $deepSeekArgs must contain --safe-mode
  if (-not (Test-ArgArrayHasSafeMode -Lines $sourceLines -VarName '$deepSeekArgs')) {
    throw "`$deepSeekArgs must contain --safe-mode."
  }
  Write-Host "safe-mode assertion 2: `$deepSeekArgs has --safe-mode"

  # 3) $claudeArgs must NOT contain --safe-mode
  if (Test-ArgArrayHasSafeMode -Lines $sourceLines -VarName '$claudeArgs') {
    throw "`$claudeArgs must NOT contain --safe-mode."
  }
  Write-Host "safe-mode assertion 3: `$claudeArgs lacks --safe-mode"

  Write-Host "Worker safe-mode: 3 source-level assertions passed"
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
