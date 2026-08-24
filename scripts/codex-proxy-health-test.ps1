$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "codex-proxy-health.ps1"

$empty = & $script -DisableSystemProxyDiscovery -JsonOnly | ConvertFrom-Json
if ($empty.status -ne "unavailable" -or $empty.proxy_detected) {
  throw "Expected an unavailable result when trusted proxy discovery is disabled."
}
if ($empty.policy -notmatch "Public proxy discovery" -or $empty.policy -notmatch "TLS bypass") {
  throw "Proxy safety policy is missing."
}

$blocked = $false
try {
  & $script -ProxyUrl "http://proxy.invalid:8080" -JsonOnly | Out-Null
} catch {
  $blocked = $_.Exception.Message -match "non-loopback proxy"
}
if (-not $blocked) { throw "Expected non-loopback proxy to require explicit approval." }

$source = Get-Content -LiteralPath $script -Raw
if ($source -match "Invoke-Expression|cert.*verify.*false|NODE_TLS_REJECT_UNAUTHORIZED") {
  throw "Unsafe proxy execution or TLS bypass detected."
}

Write-Host "Proxy health: offline discovery and safety checks passed"
