# freepi-proxy one-shot installer for Windows (PowerShell 5.1+ / 7+).
#
#   irm https://raw.githubusercontent.com/therealfreddied/freepi-proxy/main/install.ps1 | iex
#
# Installs into %LOCALAPPDATA%\freepi-proxy and writes freepi-proxy.cmd into a
# directory that is already on PATH, so `freepi-proxy` works in any new shell.
# Requires: Node.js >= 22.19 or Bun.

$ErrorActionPreference = 'Stop'

$Repo   = 'therealfreddied/freepi-proxy'
$Branch = if ($env:FREEPI_BRANCH) { $env:FREEPI_BRANCH } else { 'main' }
$Dest   = if ($env:FREEPI_HOME) { $env:FREEPI_HOME } else { Join-Path $env:LOCALAPPDATA 'freepi-proxy' }
$ShimDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'

function Fail($msg) { Write-Host "install: $msg" -ForegroundColor Red; exit 1 }

$node = Get-Command node -ErrorAction SilentlyContinue
$bun  = Get-Command bun  -ErrorAction SilentlyContinue
$runtimeOk = $false
if ($node) {
  $v = (& node -p 'process.versions.node' 2>$null)
  $ok = $false
  try { $ok = [version]$v -ge [version]'22.19.0' } catch { $ok = $false }
  if ($ok) { $runtimeOk = $true } else { Write-Host "install: Node $v is older than 22.19" -ForegroundColor Yellow }
}
if (-not $runtimeOk -and $bun) { $runtimeOk = $true }
if (-not $runtimeOk) {
  Fail "no supported runtime. Install Node.js >= 22.19 (https://nodejs.org) or Bun (https://bun.sh), then re-run."
}

$tmp = Join-Path $env:TEMP ("freepi-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  $zip = Join-Path $tmp 'src.zip'
  Write-Host "downloading $Repo@$Branch…"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -Path $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'src') } | Select-Object -First 1
  if (-not $src) { Fail 'unexpected archive layout' }

  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
  Move-Item -Path $src.FullName -Destination $Dest

  if (-not (Test-Path $ShimDir)) { New-Item -ItemType Directory -Path $ShimDir -Force | Out-Null }
  $shim = Join-Path $ShimDir 'freepi-proxy.cmd'
  $launcher = if ($node) {
    '@echo off' + "`r`n" + "node `"$Dest\src\main.ts`" %*"
  } else {
    '@echo off' + "`r`n" + "bun `"$Dest\src\main.ts`" %*"
  }
  Set-Content -Path $shim -Value $launcher -Encoding ASCII
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "installed  $Dest" -ForegroundColor Green
Write-Host "launcher   $shim"
Write-Host ''
Write-Host 'next:'
Write-Host '  freepi-proxy     # foreground proxy on http://127.0.0.1:8452'
Write-Host '  then open http://127.0.0.1:8452 to log in and use /v1'
