[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$serverDir = Join-Path $repoRoot "mcp-server"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js 20 or newer and reopen PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required."
}

Push-Location $serverDir
try {
  npm install
  npm run smoke
} finally {
  Pop-Location
}

$nodePath = (Get-Command node).Source
$serverPath = Join-Path $serverDir "server.mjs"

Write-Host ""
Write-Host "Installation complete."
Write-Host "Node: $nodePath"
Write-Host "Server: $serverPath"
Write-Host ""
Write-Host "Next: add the TOML snippet from examples\config.toml.example to your Codex config."
