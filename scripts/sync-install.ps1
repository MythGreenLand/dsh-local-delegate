# Sync the plugin source to its stable install location, after syntax checks.
# Each version syncs to its own directory so a reinstall loads fresh modules
# (a same-path reinstall keeps Node's module cache and needs an app restart).
#
# Usage (PowerShell 7):
#   pwsh -NoProfile -File scripts\sync-install.ps1
#   pwsh -NoProfile -File scripts\sync-install.ps1 -Source <dir> -Target <dir>
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
$env:NODE_NO_WARNINGS = '1'

if (-not (Test-Path -LiteralPath (Join-Path $Source 'index.js'))) {
  throw "Source does not look like the plugin directory: $Source"
}

$manifest = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw 'package.json has no version' }
if (-not $Target) {
  $Target = Join-Path $env:USERPROFILE ".dsh\local-plugins\dsh-local-delegate-$version"
}

Write-Host "source : $Source"
Write-Host "version: $version"
Write-Host "target : $Target"

# 1) Syntax-check every JS module before touching the installed copy.
$checkDir = Join-Path $env:TEMP ('dsh-local-delegate-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $checkDir | Out-Null
try {
  Get-ChildItem -LiteralPath $Source -Recurse -File -Filter '*.js' | ForEach-Object {
    $relative = $_.FullName.Substring($Source.Length + 1)
    $copy = Join-Path $checkDir ($relative -replace '\.js$', '.mjs')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $copy -Force
    node --check $copy
    if ($LASTEXITCODE -ne 0) { throw "Syntax error in $relative" }
  }
  node --check (Join-Path $Source 'scripts\verify-endpoint.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Syntax error in scripts/verify-endpoint.mjs' }
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" (Join-Path $Source 'package.json')
  if ($LASTEXITCODE -ne 0) { throw 'package.json is not valid JSON' }
  Write-Host 'syntax: OK'
} finally {
  Remove-Item -LiteralPath $checkDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 2) Mirror the source into the versioned install directory.
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$robocopyArgs = @($Source, $Target, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  '/XD', 'node_modules', '.git')
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Write-Host "synced : $Target (v$version)"
Write-Host ''
Write-Host 'Next steps (upgrade without restarting DSH):'
Write-Host "  1) Ask the DSH agent to remove the old bundle:      plugin_manager action=remove_bundle target=dsh-local-delegate"
Write-Host "  2) Then install this versioned directory:           plugin_manager action=install_bundle target=$Target"
Write-Host '  3) Verify in a session: local_health should show the new version; /localdoctor shows full diagnostics.'
Write-Host ''
Write-Host 'If the version does not change (module cache), restart the DSH desktop app once.'
