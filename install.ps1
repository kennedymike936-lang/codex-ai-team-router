[CmdletBinding()]
param(
  [string]$DeployRoot = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$sourceServerDir = Join-Path $repoRoot "mcp-server"
$serverDir = $sourceServerDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js 20 or newer and reopen PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required."
}

if (-not [string]::IsNullOrWhiteSpace($DeployRoot)) {
  $DeployRoot = [System.IO.Path]::GetFullPath($DeployRoot)
  $serverDir = Join-Path $DeployRoot "ai-cluster-mcp-server"
  $scriptDir = Join-Path $DeployRoot "scripts"
  New-Item -ItemType Directory -Force -Path $serverDir, $scriptDir | Out-Null

  Get-ChildItem -LiteralPath $sourceServerDir -File | Copy-Item -Destination $serverDir -Force
  Get-ChildItem -LiteralPath (Join-Path $repoRoot "scripts") -Filter "*.ps1" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $scriptDir -Force
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $DeployRoot $_.Name) -Force
  }
  Get-ChildItem -LiteralPath (Join-Path $repoRoot "scripts") -Filter "*.mjs" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $scriptDir -Force
  }
}

Push-Location $serverDir
try {
  if (Test-Path -LiteralPath (Join-Path $serverDir "package-lock.json")) {
    npm ci
  } else {
    npm install
  }
  npm test
} finally {
  Pop-Location
}

$nodePath = (Get-Command node).Source
$serverPath = Join-Path $serverDir "server.mjs"

Write-Host ""
Write-Host "Installation complete."
Write-Host "Node: $nodePath"
Write-Host "Server: $serverPath"
if (-not [string]::IsNullOrWhiteSpace($DeployRoot)) {
  Write-Host "Deployed: $DeployRoot"
}
Write-Host ""
Write-Host "Next: add the TOML snippet from examples\config.toml.example to your Codex config."
