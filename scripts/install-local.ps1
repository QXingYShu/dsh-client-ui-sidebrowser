<#
.SYNOPSIS
  Register dsh-sidebrowser into a local DSH profile and sync the built artifacts.

.DESCRIPTION
  A DSH plugin is only loaded by the Host if TWO registry entries exist in the
  profile's package.json:

    1. dependencies["dsh-sidebrowser"]  -> "link:<repo>"  (pnpm links the dir)
    2. dsh.profile.bundles[]             -> "@dsh-external/dsh-client-ui-sidebrowser"

  The Host then resolves each bundle by reading node_modules/<bundle>/package.json
  and, if it declares dsh.bundle.patch, parses the `insert:` rows out of that
  file to create the plugin rows. So the plugin's own cordis.patch.yml supplies
  the insert row automatically -- you must NOT hand-add an insert to
  ~/.dsh/cordis.patch.yml, and doing so risks a duplicate row.

  Node_modules note: pnpm normally turns the link: dependency into a junction to
  this repo. If node_modules already holds a plain directory instead, this script
  copies the built artifacts into it so the Host loads current code. Pass
  -PreferJunction to replace that directory with a junction instead.

.PARAMETER Profile
  DSH profile name under ~/.dsh/profiles. Defaults to "desktop".

.PARAMETER SyncOnly
  Skip registration; only re-copy the build output into node_modules.

.PARAMETER PreferJunction
  Replace a plain node_modules directory with a junction to this repo (destructive).

.EXAMPLE
  pwsh -File scripts/install-local.ps1
  pwsh -File scripts/install-local.ps1 -SyncOnly
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$SyncOnly,
  [switch]$PreferJunction
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo   = Split-Path -Parent $PSScriptRoot
$dsh    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$dir    = Join-Path $dsh "profiles\$Profile"
$pfile  = Join-Path $dir 'package.json'
$pkgName   = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).name
$depAlias  = 'dsh-sidebrowser'

if (-not (Test-Path -LiteralPath $pfile)) {
  throw "profile not found: $pfile (looked for DSH_HOME=$dsh, profile=$Profile)"
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Register-Plugin {
  Write-Step "registering $pkgName into profile '$Profile'"

  # Copy through a temp file: a half-written package.json would stop the Host
  # from booting, which is far worse than a failed install.
  $backup = "$pfile.sidebrowser.bak"
  Copy-Item -LiteralPath $pfile -Destination $backup -Force

  $json = Get-Content -LiteralPath $pfile -Raw
  $json | ConvertFrom-Json | Out-Null   # fail fast on a pre-existing syntax error
  $pkg = $json | ConvertFrom-Json

  $changed = $false
  if (-not $pkg.dependencies.PSObject.Properties.Name.Contains($depAlias)) {
    $link = 'link:' + ($repo -replace '\\', '/')
    $pkg.dependencies | Add-Member -NotePropertyName $depAlias -NotePropertyValue $link
    $changed = $true
    Write-Host "    + dependencies.$depAlias = $link"
  } else {
    Write-Host "    = dependencies.$depAlias already present"
  }

  $bundles = $pkg.dsh.profile.bundles
  if ($bundles -notcontains $pkgName) {
    # Rebuild the array so JSON.stringify-equivalent output keeps one item per line.
    $pkg.dsh.profile.bundles = @($bundles) + $pkgName
    $changed = $true
    Write-Host "    + bundles[] += $pkgName"
  } else {
    Write-Host "    = bundles[] already contains $pkgName"
  }

  if (-not $changed) { Write-Host '    nothing to do' ; return }

  $out = ($pkg | ConvertTo-Json -Depth 20) -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText($pfile, $out, (New-Object System.Text.UTF8Encoding $false))

  # Re-parse what we actually wrote, not what we intended to write.
  $check = Get-Content -LiteralPath $pfile -Raw | ConvertFrom-Json
  if ($check.dsh.profile.bundles -notcontains $pkgName) { throw 'post-write verification failed' }
  Write-Host "    wrote $pfile (backup: $backup)"
}

function Sync-Artifacts {
  $nm = Join-Path $dir "node_modules\$pkgName"
  if (-not (Test-Path -LiteralPath $nm)) {
    throw "node_modules entry missing: $nm`nRun a 'pnpm install' in $dir, or run this script without -SyncOnly after creating the link."
  }

  $item = Get-Item -LiteralPath $nm -Force
  if ($item.LinkType) {
    Write-Step "node_modules entry is already a link ($($item.LinkType)) -> nothing to sync"
    return
  }

  if ($PreferJunction) {
    Write-Step "replacing plain node_modules dir with a junction to $repo"
    $resolved = (Resolve-Path -LiteralPath $nm).Path
    if ($resolved -ne $nm) { throw "path mismatch, refusing to delete: $resolved" }
    Remove-Item -LiteralPath $nm -Recurse -Force
    New-Item -ItemType Junction -Path $nm -Target $repo | Out-Null
    Write-Host '    junction created'
    return
  }

  Write-Step 'syncing build output into node_modules (plain directory)'
  $lib = Join-Path $repo 'lib'
  if (-not (Test-Path -LiteralPath $lib)) {
    throw "no build output at $lib -- run 'tsdown' first"
  }
  # Copy files (never delete) so a partially-built lib/ cannot leave a hole.
  Copy-Item -Path (Join-Path $lib '*') -Destination (Join-Path $nm 'lib') -Recurse -Force
  foreach ($f in 'cordis.patch.yml', 'package.json', 'icon.svg', 'README.md', 'README.zh.md', 'LICENSE') {
    $src = Join-Path $repo $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $nm $f) -Force }
  }
  # Display metadata (Plugin Manager card title/description) lives here; the
  # Host reads it through exports["./locale/*.json"] without activating us.
  $locales = Join-Path $repo 'locale'
  if (Test-Path -LiteralPath $locales) {
    $localeDest = Join-Path $nm 'locale'
    New-Item -ItemType Directory -Force -Path $localeDest | Out-Null
    Copy-Item -Path (Join-Path $locales '*') -Destination $localeDest -Recurse -Force
  }
  Write-Host "    lib/ + metadata copied to $nm"
}

if (-not $SyncOnly) { Register-Plugin }
Sync-Artifacts

Write-Step 'done -- restart DeepSeek Harness for the Host to claim the plugin'
Write-Host '    The client half additionally needs a browser page refresh.'