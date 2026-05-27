#Requires -Version 5.1
# Daily launcher — runs every time Grin-Money-Desktop.bat is double-clicked.
# Verifies Node.js is present, then execs the Node app.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$Root    = Split-Path $PSScriptRoot -Parent
$AppDir  = Join-Path $Root 'app'
$Entry   = Join-Path $AppDir 'server.js'

function Write-Step($m) { Write-Host "[boot] $m" -ForegroundColor Cyan }
function Write-OK($m)   { Write-Host "[ok]   $m" -ForegroundColor Green }
function Write-ErrX($m) { Write-Host "[err]  $m" -ForegroundColor Red }

# ─── Verify Node.js ──────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-ErrX 'Node.js is not installed.'
    Write-Host ''
    Write-Host 'Run the installer first:' -ForegroundColor Yellow
    Write-Host '    irm https://grin.money/install | iex' -ForegroundColor White
    Write-Host ''
    Read-Host 'Press Enter to exit'
    exit 1
}

# ─── Install npm deps on first run ───────────────────────────────────────────
if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
    Write-Step 'Installing Node dependencies (first run only)…'
    Push-Location $AppDir
    npm install --omit=dev
    Pop-Location
    Write-OK 'Dependencies installed.'
}

# ─── Launch the app ──────────────────────────────────────────────────────────
Write-Step 'Starting Grin Money Desktop…'
Push-Location $AppDir
node $Entry
Pop-Location
