[CmdletBinding()]
param(
  [string]$ProxyUrl = "",

  [string[]]$Target = @(
    "https://api.x.ai/v1/models",
    "https://grok.com",
    "https://github.com"
  ),

  [ValidateRange(3, 30)]
  [int]$TimeoutSeconds = 15,

  [switch]$AllowNonLoopback,

  [switch]$DisableSystemProxyDiscovery,

  [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"

function Get-WindowsSystemProxy {
  if ($env:OS -ne "Windows_NT") { return "" }
  $settings = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
  if (-not $settings.ProxyEnable -or [string]::IsNullOrWhiteSpace([string]$settings.ProxyServer)) { return "" }
  $value = [string]$settings.ProxyServer
  if ($value -match '(?:^|;)https?=([^;]+)') { $value = $Matches[1] }
  if ($value -notmatch '^https?://') { $value = "http://$value" }
  return $value
}

function Test-LoopbackProxy([uri]$Uri) {
  return $Uri.Host -in @("127.0.0.1", "localhost", "::1")
}

if ([string]::IsNullOrWhiteSpace($ProxyUrl) -and -not $DisableSystemProxyDiscovery) {
  $ProxyUrl = Get-WindowsSystemProxy
}

$result = [ordered]@{
  schema_version = "1.0"
  status = "unavailable"
  proxy_detected = $false
  proxy_scope = "none"
  target_count = @($Target).Count
  healthy_count = 0
  checks = @()
  policy = "Only an explicitly supplied or Windows-configured trusted HTTP/HTTPS proxy is checked. Public proxy discovery, subscription inspection, TLS bypass, and node switching are forbidden."
}

if (-not [string]::IsNullOrWhiteSpace($ProxyUrl)) {
  $proxyUri = $null
  if (-not [uri]::TryCreate($ProxyUrl, [System.UriKind]::Absolute, [ref]$proxyUri) -or $proxyUri.Scheme -notin @("http", "https")) {
    throw "Trusted proxy must be an absolute HTTP/HTTPS URL."
  }
  if (-not $AllowNonLoopback -and -not (Test-LoopbackProxy $proxyUri)) {
    throw "Refusing a non-loopback proxy unless -AllowNonLoopback is explicitly set."
  }
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw "curl.exe is required for proxy health checks."
  }

  $result.proxy_detected = $true
  $result.proxy_scope = $(if (Test-LoopbackProxy $proxyUri) { "loopback" } else { "explicit_remote" })
  $checks = foreach ($url in $Target) {
    $targetUri = $null
    if (-not [uri]::TryCreate($url, [System.UriKind]::Absolute, [ref]$targetUri) -or $targetUri.Scheme -ne "https") {
      [ordered]@{ host = "invalid"; reachable = $false; http_status = 0; elapsed_ms = $null; error = "invalid_https_target" }
      continue
    }
    $raw = & curl.exe --proxy $ProxyUrl --silent --show-error --output NUL `
      --write-out "%{http_code} %{time_total}" --connect-timeout ([Math]::Min(8, $TimeoutSeconds)) `
      --max-time $TimeoutSeconds $url 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($raw -join " ").Trim()
    $status = 0
    $seconds = $null
    if ($text -match '^(\d{3})\s+([0-9.]+)$') {
      $status = [int]$Matches[1]
      $seconds = [double]$Matches[2]
    }
    $reachable = $exitCode -eq 0 -and $status -ge 200 -and $status -lt 500 -and $status -ne 407
    [ordered]@{
      host = $targetUri.Host
      reachable = $reachable
      http_status = $status
      elapsed_ms = $(if ($null -ne $seconds) { [int][Math]::Round($seconds * 1000) } else { $null })
      error = $(if ($reachable) { $null } elseif ($status -eq 407) { "proxy_auth_required" } elseif ($exitCode -ne 0) { "connect_failed" } else { "http_$status" })
    }
  }
  $result.checks = @($checks)
  $result.healthy_count = @($checks | Where-Object { $_.reachable }).Count
  $result.status = $(if ($result.healthy_count -eq $result.target_count) { "healthy" } elseif ($result.healthy_count -gt 0) { "degraded" } else { "unhealthy" })
}

if ($JsonOnly) {
  $result | ConvertTo-Json -Depth 5 -Compress
} else {
  $result | ConvertTo-Json -Depth 5
}
