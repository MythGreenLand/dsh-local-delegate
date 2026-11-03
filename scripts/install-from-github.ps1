#requires -Version 7
<#
.SYNOPSIS
  Download a dsh-local-delegate GitHub Release and place it in its versioned
  DSH local-plugins directory. Prints the plugin_manager step to finish.

.DESCRIPTION
  This script only downloads, verifies, and unpacks the plugin. Registering the
  bundle stays with DSH: in a DSH session ask the agent to run
    plugin_manager action=install_bundle target=<printed directory>
  (after action=remove_bundle when upgrading an existing install).

.EXAMPLE
  pwsh -NoProfile -File scripts/install-from-github.ps1

.EXAMPLE
  pwsh -NoProfile -File scripts/install-from-github.ps1 -Version v0.4.1

.EXAMPLE
  pwsh -NoProfile -File scripts/install-from-github.ps1 -Version latest -Force
#>
[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [string]$InstallDir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = 'MythGreenLand/dsh-local-delegate'
$headers = @{
  'User-Agent' = 'dsh-local-delegate-installer'
  'Accept'     = 'application/vnd.github+json'
}

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  $bundled = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  return $null
}

function Invoke-GitHubJson([string]$Uri) {
  try {
    return Invoke-RestMethod -Uri $Uri -Headers $headers -TimeoutSec 30
  } catch {
    $node = Get-NodePath
    if ($node) {
      $js = 'const u=process.argv[1];fetch(u,{headers:{"User-Agent":"dsh-local-delegate-installer","Accept":"application/vnd.github+json"}}).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(j=>process.stdout.write(JSON.stringify(j))).catch(e=>{console.error(e.message);process.exit(1)})'
      $json = & $node -e $js $Uri
      if ($LASTEXITCODE -eq 0 -and $json) { return ($json | ConvertFrom-Json) }
    }
    throw "GitHub API request failed: $Uri — $($_.Exception.Message). Check network/proxy or download the asset manually from https://github.com/$repo/releases"
  }
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $headers -TimeoutSec 180
    return
  } catch {
    $node = Get-NodePath
    if (-not $node) { throw "download failed: $Uri — $($_.Exception.Message)" }
    $js = 'const fs=require("fs");const [u,o]=process.argv.slice(1);fetch(u,{headers:{"User-Agent":"dsh-local-delegate-installer"}}).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync(o,Buffer.from(b))).catch(e=>{console.error(e.message);process.exit(1)})'
    & $node -e $js $Uri $OutFile
    if ($LASTEXITCODE -ne 0) { throw "download failed: $Uri (node fetch fallback exited $LASTEXITCODE)" }
  }
}

$requestedTag = ''
if ($Version -ne 'latest' -and $Version -ne '') {
  $requestedTag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
}

Write-Host "dsh-local-delegate installer"
Write-Host "repository : https://github.com/$repo"

$release = $null
$tag = ''
if ($requestedTag -and $requestedTag -ne 'latest') {
  $release = Invoke-GitHubJson "https://api.github.com/repos/$repo/releases/tags/$requestedTag"
  $tag = [string]$release.tag_name
} else {
  try {
    $release = Invoke-GitHubJson "https://api.github.com/repos/$repo/releases/latest"
    $tag = [string]$release.tag_name
  } catch {
    $tag = ''
    Write-Warning "cannot resolve the latest release ($($_.Exception.Message)); falling back to the repository default branch archive"
  }
}

$version = if ($tag) { $tag.TrimStart('v') } elseif ($requestedTag) { $requestedTag.TrimStart('v') } else { '' }
if ($requestedTag -and $version -and ($version -ne $requestedTag.TrimStart('v'))) {
  throw "release tag mismatch: requested $requestedTag, resolved $tag"
}

$downloadUrl = ''
if ($release) {
  $asset = @($release.assets) | Where-Object { $_.name -match '\.zip$' } | Select-Object -First 1
  if ($asset) {
    $downloadUrl = [string]$asset.browser_download_url
  } else {
    $downloadUrl = "https://github.com/$repo/archive/refs/tags/$tag.zip"
    Write-Warning "release $tag has no zip asset; downloading the source archive instead"
  }
} else {
  if ($requestedTag) {
    $downloadUrl = "https://github.com/$repo/archive/refs/tags/$requestedTag.zip"
  } else {
    $downloadUrl = "https://github.com/$repo/archive/refs/heads/main.zip"
  }
}
Write-Host "release    : $(if ($tag) { $tag } else { '(default branch)' })"
Write-Host "download   : $downloadUrl"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-local-delegate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $zipPath = Join-Path $tempRoot 'plugin.zip'
  Invoke-Download -Uri $downloadUrl -OutFile $zipPath

  $extractDir = Join-Path $tempRoot 'extract'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

  $manifest = Get-ChildItem -LiteralPath $extractDir -Recurse -File -Filter 'package.json' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'index.js') } |
    Select-Object -First 1
  if (-not $manifest) {
    throw 'downloaded archive does not look like dsh-local-delegate (package.json next to index.js was not found)'
  }
  $pluginDir = $manifest.DirectoryName
  $package = Get-Content -LiteralPath (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json
  if ([string]$package.name -ne 'dsh-local-delegate') {
    throw "unexpected package name in the archive: $($package.name)"
  }
  $detectedVersion = [string]$package.version
  if (-not $detectedVersion) { throw 'the archive package.json has no version' }
  if ($version -and $detectedVersion -ne $version) {
    throw "version mismatch: release $tag contains dsh-local-delegate $detectedVersion"
  }
  $version = $detectedVersion

  if (-not $InstallDir) {
    $InstallDir = Join-Path $env:USERPROFILE ".dsh\local-plugins\dsh-local-delegate-$version"
  }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
  if (Test-Path -LiteralPath $InstallDir) {
    if (-not $Force) {
      throw "install directory already exists: $InstallDir`nRe-run with -Force to replace it, or pass -InstallDir to install elsewhere."
    }
    Write-Host "replacing   : $InstallDir"
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $pluginDir '*') -Destination $InstallDir -Recurse -Force

  foreach ($required in @('index.js', 'client.js', 'package.json', 'cordis.patch.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $required))) {
      throw "installed copy is missing $required"
    }
  }

  Write-Host ''
  Write-Host "installed  : $InstallDir"
  Write-Host "version    : dsh-local-delegate $version"
  Write-Host ''
  Write-Host 'Next (run in a DSH session; ask your agent):'
  Write-Host '  # upgrading an existing install first:'
  Write-Host '  plugin_manager action=remove_bundle target=dsh-local-delegate'
  Write-Host "  plugin_manager action=install_bundle target=$InstallDir"
  Write-Host ''
  Write-Host 'Then refresh the Web GUI (F5) and verify Settings -> 本地模型 / the'
  Write-Host 'plugin Configure page loads, and local_health reports the new version.'
  if ($version -match '^0\.4\.') {
    Write-Host 'For 0.4.x also check: 「本地 AI 介入程度」/「SlaveAgentTeams」cards and'
    Write-Host 'the composer 「本地 AI：默认 ▾」 picker (0.4.1+).'
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
