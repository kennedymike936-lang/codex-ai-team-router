[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string]$Cwd = (Get-Location).Path,

  [ValidateRange(1000, 50000)]
  [int]$MaxChars = 10000,

  [ValidateRange(5, 100)]
  [int]$MaxFiles = 40,

  [ValidateRange(5, 100)]
  [int]$MaxMatches = 30,

  [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Test-ExcludedPath {
  param([string]$RelativePath)
  $path = $RelativePath.Replace("\", "/").TrimStart("./")
  if ($path -match '(?i)(^|/)(\.git|node_modules|vendor|dist|build|coverage|runs?|outputs?|\.cache|__pycache__|\.pytest_cache)(/|$)') { return $true }
  $name = [System.IO.Path]::GetFileName($path)
  if ($name -match '(?i)^\.env(?:\..*)?$') { return $true }
  if ($name -match '(?i)^(\.npmrc|\.pypirc|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?)$') { return $true }
  if ($name -match '(?i)^(id_rsa|id_ed25519)$') { return $true }
  if ($name -match '(?i)\.(pem|key|p12|pfx|jks|crt|cer|der|keystore)$') { return $true }
  return $false
}

function Protect-Line {
  param([string]$Text, [int]$MaxLength = 240)
  if ($null -eq $Text) { return "" }
  $value = [string]$Text
  $value = [regex]::Replace($value, '(?i)\b(sk-[A-Za-z0-9_-]{16,})\b', '[REDACTED]')
  $value = [regex]::Replace($value, '(?i)\b(authorization\s*:\s*bearer\s+)\S+', '$1[REDACTED]')
  $value = [regex]::Replace($value, '(?i)\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)["'']?[^\s,"'']{8,}', '$1$2[REDACTED]')
  if ($value.Length -gt $MaxLength) { return $value.Substring(0, $MaxLength - 3) + "..." }
  return $value
}

function Invoke-WorkspaceCommand {
  param([string]$Command, [string[]]$Arguments)
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return @() }
  $previousErrorAction = $ErrorActionPreference
  Push-Location $Cwd
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { return @() }
    return @($output | ForEach-Object { [string]$_ })
  } catch {
    return @()
  } finally {
    $ErrorActionPreference = $previousErrorAction
    Pop-Location
  }
}

function Get-TaskTerms {
  param([string]$Text)
  $stopWords = @(
    "the", "and", "for", "with", "from", "this", "that", "into", "only", "read", "file", "files",
    "task", "project", "report", "inspect", "find", "please", "without", "under", "work", "workspace",
    "locate", "concisely", "describe", "existing", "including", "explain", "stages", "cite", "main", "one",
    "deterministic", "current", "how"
  )
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $terms = @()
  foreach ($match in [regex]::Matches($Text, '[\p{L}\p{N}_][\p{L}\p{N}_.-]{2,}')) {
    $term = $match.Value.Trim(".", "-", "_")
    if ($term.Length -lt 3 -or $term.Length -gt 32) { continue }
    if ($stopWords -contains $term.ToLowerInvariant()) { continue }
    if ($seen.Add($term)) { $terms += $term }
    if ($terms.Count -ge 8) { break }
  }
  return @($terms)
}

function Add-Section {
  param([System.Collections.Generic.List[string]]$Target, [string]$Name, [string[]]$Lines)
  $Target.Add("## $Name")
  if ($Lines.Count -eq 0) {
    $Target.Add("(none)")
  } else {
    foreach ($line in $Lines) { $Target.Add((Protect-Line -Text $line)) }
  }
  $Target.Add("")
}

if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) { throw "Cwd does not exist: $Cwd" }
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path
$startedAt = Get-Date
$terms = @(Get-TaskTerms -Text $Task)

$isGit = (Invoke-WorkspaceCommand -Command "git" -Arguments @("rev-parse", "--is-inside-work-tree") | Select-Object -First 1) -eq "true"
$gitLines = @("repository: $(if ($isGit) { 'git' } else { 'non-git' })")
$changedPaths = @()
if ($isGit) {
  $branch = Invoke-WorkspaceCommand -Command "git" -Arguments @("branch", "--show-current") | Select-Object -First 1
  $head = Invoke-WorkspaceCommand -Command "git" -Arguments @("log", "-1", "--format=%h %s") | Select-Object -First 1
  if ($branch) { $gitLines += "branch: $branch" }
  if ($head) { $gitLines += "head: $head" }
  $status = @(Invoke-WorkspaceCommand -Command "git" -Arguments @("status", "--short", "--untracked-files=all") |
    Where-Object { $_ -and -not (Test-ExcludedPath -RelativePath ([string]$_).Substring([Math]::Min(3, ([string]$_).Length))) } |
    Select-Object -First 25)
  if ($status.Count -eq 0) { $gitLines += "status: clean" } else {
    $gitLines += "status_count_shown: $($status.Count)"
    $gitLines += @($status | ForEach-Object { "status: $_" })
    $changedPaths = @($status | ForEach-Object {
      $line = [string]$_
      if ($line.Length -gt 3) { $line.Substring(3).Trim('"') }
    } | Where-Object { $_ })
  }
}

$allFiles = @()
if (Get-Command rg -ErrorAction SilentlyContinue) {
  $allFiles = @(Invoke-WorkspaceCommand -Command "rg" -Arguments @("--files", "--hidden") | Where-Object { $_ })
} else {
  try {
    $allFiles = @(Get-ChildItem -LiteralPath $Cwd -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      $_.FullName.Substring($Cwd.Length).TrimStart("\", "/")
    })
  } catch { $allFiles = @() }
}
$safeFiles = @($allFiles | Where-Object { -not (Test-ExcludedPath -RelativePath $_) } | Select-Object -Unique)

$manifestLines = @()
$packageFiles = @($safeFiles | Where-Object { [System.IO.Path]::GetFileName($_) -ieq "package.json" } | Sort-Object { ($_ -split '[/\\]').Count } | Select-Object -First 4)
foreach ($packageFile in $packageFiles) {
  try {
    $packagePath = Join-Path $Cwd $packageFile
    if ((Get-Item -LiteralPath $packagePath).Length -gt 256KB) { continue }
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $identity = @($package.name, $package.version) | Where-Object { $_ }
    $manifestLines += "package: $packageFile $(Protect-Line -Text ($identity -join '@'))"
    if ($package.scripts) {
      $scriptNames = @($package.scripts.PSObject.Properties.Name | Sort-Object | Select-Object -First 15)
      if ($scriptNames.Count -gt 0) { $manifestLines += "scripts: $($scriptNames -join ', ')" }
    }
  } catch { $manifestLines += "package: $packageFile (unreadable)" }
}
$otherManifestNames = @("pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Makefile", "Dockerfile", "tsconfig.json")
$otherManifests = @($safeFiles | Where-Object { $otherManifestNames -contains [System.IO.Path]::GetFileName($_) } | Select-Object -First 12)
foreach ($manifest in $otherManifests) { $manifestLines += "manifest: $manifest" }

$sourceExtensions = @(".ps1", ".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".sh", ".md", ".json", ".toml", ".yml", ".yaml", ".html", ".css")
$scoredFiles = foreach ($file in $safeFiles) {
  $extension = [System.IO.Path]::GetExtension($file)
  if ($sourceExtensions -notcontains $extension -and [System.IO.Path]::GetFileName($file) -notin @("Makefile", "Dockerfile")) { continue }
  $score = 0
  foreach ($term in $terms) { if ($file.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $score += 5 } }
  if ($changedPaths -contains $file) { $score += 8 }
  if ([System.IO.Path]::GetFileName($file) -match '(?i)^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|README\.md)$') { $score += 3 }
  [pscustomobject]@{ Path = $file; Score = $score }
}
$candidateLines = @($scoredFiles | Sort-Object @{ Expression = "Score"; Descending = $true }, @{ Expression = "Path"; Descending = $false } |
  Select-Object -First $MaxFiles | ForEach-Object { "file: $($_.Path) score=$($_.Score)" })

$matchLines = @()
$searchTerms = @($terms)
if ($searchTerms.Count -eq 0) { $searchTerms = @("TODO", "FIXME", "error", "fail") }
$expandedTerms = [System.Collections.Generic.List[string]]::new()
foreach ($term in $searchTerms) {
  $expandedTerms.Add($term)
  if ($term.Length -gt 6 -and $term -match '(?i)ing$') { $expandedTerms.Add($term.Substring(0, $term.Length - 3)) }
  if ($term.Length -gt 7 -and $term -match '(?i)ation$') { $expandedTerms.Add($term.Substring(0, $term.Length - 5)) }
}
$searchPattern = (@($expandedTerms | Select-Object -Unique) | ForEach-Object {
  ([regex]::Escape($_)).Replace("_", "[-_]")
}) -join "|"
if ($searchPattern -and (Get-Command rg -ErrorAction SilentlyContinue)) {
  $rgArgs = @("-n", "-i", "--no-heading", "--color", "never", "--max-count", "8", "-e", $searchPattern)
  foreach ($glob in @("*.ps1", "*.mjs", "*.js", "*.ts", "*.tsx", "*.py", "*.go", "*.rs", "*.md", "*.json", "*.toml", "*.yml", "*.yaml", "*.html")) { $rgArgs += @("-g", $glob) }
  foreach ($glob in @("!**/.git/**", "!**/node_modules/**", "!**/dist/**", "!**/build/**", "!**/runs/**", "!**/outputs/**", "!**/.env*", "!**/*.pem", "!**/*.key")) { $rgArgs += @("-g", $glob) }
  $rgArgs += "."
  $rawMatches = @(Invoke-WorkspaceCommand -Command "rg" -Arguments $rgArgs | Select-Object -First ($MaxMatches * 8))
  $scoredMatches = @()
  foreach ($match in $rawMatches) {
    $pathPart = ([string]$match -split ':', 2)[0]
    if (Test-ExcludedPath -RelativePath $pathPart) { continue }
    $normalizedMatch = ([string]$match).Replace("-", "_")
    $normalizedPath = $pathPart.Replace("-", "_")
    $score = 0
    foreach ($term in $terms) {
      $normalizedTerm = $term.Replace("-", "_")
      if ($normalizedMatch.IndexOf($normalizedTerm, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $score += 1 }
      if ($normalizedPath.IndexOf($normalizedTerm, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $score += 2 }
    }
    $scoredMatches += [pscustomobject]@{ Score = $score; Text = "match: $(Protect-Line -Text $match)" }
  }
  $matchLines = @($scoredMatches | Sort-Object @{ Expression = "Score"; Descending = $true }, @{ Expression = "Text"; Descending = $false } |
    Select-Object -First $MaxMatches | ForEach-Object { $_.Text })
} else {
  foreach ($candidate in $scoredFiles | Sort-Object Score -Descending | Select-Object -First 20) {
    try {
      $absolutePath = Join-Path $Cwd $candidate.Path
      if ((Get-Item -LiteralPath $absolutePath).Length -gt 512KB) { continue }
      foreach ($hit in Select-String -LiteralPath $absolutePath -Pattern $searchTerms -SimpleMatch -ErrorAction SilentlyContinue | Select-Object -First 2) {
        $matchLines += "match: $($candidate.Path):$($hit.LineNumber):$(Protect-Line -Text $hit.Line)"
        if ($matchLines.Count -ge $MaxMatches) { break }
      }
    } catch {}
    if ($matchLines.Count -ge $MaxMatches) { break }
  }
}

$packLines = [System.Collections.Generic.List[string]]::new()
$packLines.Add("# Mechanical Scout Pack")
$packLines.Add("terms: $(if ($terms.Count -gt 0) { $terms -join ', ' } else { '(none)' })")
$packLines.Add("")
Add-Section -Target $packLines -Name "Git" -Lines $gitLines
Add-Section -Target $packLines -Name "Manifests and scripts" -Lines $manifestLines
Add-Section -Target $packLines -Name "Relevant file candidates" -Lines $candidateLines
Add-Section -Target $packLines -Name "Bounded keyword matches" -Lines $matchLines

$rawContent = ($packLines -join "`n").Trim()
$marker = "`n...[SCOUT PACK TRUNCATED]"
$truncated = $rawContent.Length -gt $MaxChars
if ($truncated) {
  $take = [Math]::Max(0, $MaxChars - $marker.Length)
  $content = $rawContent.Substring(0, $take) + $marker
} else { $content = $rawContent }

$result = [ordered]@{
  schema_version = "1.0"
  content = $content
  char_count = $content.Length
  max_chars = $MaxChars
  truncated = $truncated
  term_count = $terms.Count
  file_count = $candidateLines.Count
  match_count = $matchLines.Count
  is_git = $isGit
  elapsed_ms = [math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
}
if ($JsonOnly) { $result | ConvertTo-Json -Depth 4 -Compress } else { Write-Output $content }
