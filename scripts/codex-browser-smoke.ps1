<#
.DESCRIPTION
  Deterministic browser smoke test wrapper for the AI Team Gate.
  Calls codex-browser-smoke.mjs with Node.js and returns structured results.
  Detects uncaught errors, canvas presence, and canvas pixel render capability
  for changed HTML files.

  Output: JSON object with "status" ("pass"/"fail"/"not_detected") and per-file details.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$HtmlFiles,
  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$smokeMjs = Join-Path $scriptDir "codex-browser-smoke.mjs"

if (-not (Test-Path -LiteralPath $smokeMjs)) {
  [ordered]@{ status = "not_detected"; reason = "Browser smoke runner is missing." } | ConvertTo-Json -Compress
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $result = [ordered]@{
    status = "not_detected"
    reason = "Node.js is not available on PATH."
  }
  $result | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

$argList = @($HtmlFiles) + @("--root", $Root)

try {
  $output = & $node.Source $smokeMjs @argList 2>&1 | Out-String
  $exitCode = $LASTEXITCODE

  if ($exitCode -eq 0) {
    # Parse the JSON array output to emit a clean result
    try {
      $parsed = $output | ConvertFrom-Json
    } catch {
      $parsed = $null
    }

    $parsed = @($parsed)
    $notDetected = @($parsed | Where-Object { $_.status -eq "not_detected" })
    if ($notDetected.Count -gt 0) {
      [ordered]@{
        status = "not_detected"
        reason = @($notDetected | ForEach-Object { $_.reason }) -join "; "
      } | ConvertTo-Json -Depth 5 -Compress
      exit 0
    }

    $failedFiles = @()
    $passedFiles = @()
    foreach ($item in $parsed) {
      if ($item.status -eq "fail") { $failedFiles += $item.file }
      else { $passedFiles += $item.file }
    }

    $result = [ordered]@{
      status = $(if ($failedFiles.Count -eq 0) { "pass" } else { "fail" })
      files_tested = @($parsed).Count
      files_passed = $passedFiles.Count
      files_failed = $failedFiles.Count
      per_file = @($parsed)
    }
  } else {
    # Non-zero exit: try to parse output for structured error
    try {
      $parsed = $output | ConvertFrom-Json
    } catch {
      $parsed = $null
    }

    if ($parsed -and ($parsed | Where-Object { $_.status -eq "not_detected" }).Count -gt 0) {
      $result = [ordered]@{
        status = "not_detected"
        reason = ($parsed | Where-Object { $_.status -eq "not_detected" } | ForEach-Object { $_.reason }) -join "; "
      }
    } elseif ($parsed) {
      $items = @($parsed)
      $failedItems = @($items | Where-Object { $_.status -eq "fail" })
      $result = [ordered]@{
        status = "fail"
        files_tested = $items.Count
        files_passed = @($items | Where-Object { $_.status -eq "pass" }).Count
        files_failed = $failedItems.Count
        per_file = $items
      }
    } else {
      $result = [ordered]@{
        status = "fail"
        reason = "Browser smoke test exited with code $exitCode."
        output = $output.Trim()
      }
    }
  }
} catch {
  $errMsg = $_.Exception.Message
  if ($errMsg -match "not_detected|no browser|no Chromium|skip") {
    $result = [ordered]@{
      status = "not_detected"
      reason = $errMsg
    }
  } else {
    $result = [ordered]@{
      status = "fail"
      reason = "Browser smoke test infrastructure failure: $errMsg"
    }
  }
}

$result | ConvertTo-Json -Depth 5 -Compress
