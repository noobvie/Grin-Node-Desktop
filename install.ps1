#Requires -Version 5.1
# Grin Money Desktop — one-liner installer
# Served at https://grin.money/install — target of:
#     irm https://grin.money/install | iex
#
# Runs ONCE on a fresh machine. Installs Git + Node.js, clones the repo,
# then hands off to scripts/bootstrap.ps1 (which launches the Node app).

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$REPO_URL    = 'https://github.com/noobvie/Grin-Money-Desktop.git'
$INSTALL_DIR = Join-Path $env:USERPROFILE 'Grin-Money-Desktop'

function Write-Step($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "[ok]      $msg" -ForegroundColor Green }
function Write-Warn2($m)  { Write-Host "[warn]    $m"   -ForegroundColor Yellow }

# ─── Self-elevate ────────────────────────────────────────────────────────────
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$current).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Step 'Elevating to Administrator…'
    Start-Process powershell.exe `
        -ArgumentList '-NoProfile','-Command','irm https://grin.money/install | iex' `
        -Verb RunAs
    exit 0
}

Write-Host ''
Write-Host '╔════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║  Grin Money Desktop — Installer                       ║' -ForegroundColor Cyan
Write-Host '╚════════════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''

# ─── 1. Git ──────────────────────────────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing Git…'
    winget install --id Git.Git -e --silent `
        --accept-source-agreements --accept-package-agreements
    $env:PATH = "$env:PATH;$env:ProgramFiles\Git\cmd"
    Write-OK 'Git installed.'
} else {
    Write-OK 'Git already present.'
}

# ─── 2. Node.js ──────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing Node.js LTS…'
    winget install --id OpenJS.NodeJS.LTS -e --silent `
        --accept-source-agreements --accept-package-agreements
    $env:PATH = "$env:PATH;$env:ProgramFiles\nodejs"
    Write-OK 'Node.js installed.'
} else {
    Write-OK 'Node.js already present.'
}

# ─── 3. Clone or update repo ─────────────────────────────────────────────────
if (Test-Path $INSTALL_DIR) {
    Write-Step "Existing install found at $INSTALL_DIR — pulling latest…"
    Push-Location $INSTALL_DIR
    git pull --ff-only
    Pop-Location
} else {
    Write-Step "Cloning to $INSTALL_DIR…"
    git clone $REPO_URL $INSTALL_DIR
}
Write-OK 'Repository ready.'

# ─── 4. Hand off to daily launcher ───────────────────────────────────────────
Write-Step 'Launching wallet…'
& (Join-Path $INSTALL_DIR 'Grin-Money-Desktop.bat')
