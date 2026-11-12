#Requires -Version 5.1
# Daily launcher - runs every time Grin-Node-Desktop.bat is double-clicked, and
# at logon (with -Background) from the scheduled task install.ps1 registers.
# Opens the panel when the app already runs; otherwise relaunches itself
# elevated when needed, verifies Node.js, installs the npm dependencies when
# package-lock.json changed, then runs the Node app.
#
# -Background: no browser, no prompt, no elevation request. A failure is
# written to logs\bootstrap.log, because nobody is watching a console.
#
# This file is ASCII-only on purpose: Windows PowerShell 5.1 reads a script
# without a BOM in the ANSI code page, where a multi-byte UTF-8 character can
# decode to a quote and break parsing.
param([switch]$Background)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$Root    = Split-Path $PSScriptRoot -Parent
$AppDir  = Join-Path $Root 'app'
$Entry   = Join-Path $AppDir 'server.js'
$MinNode = 20
$Port    = 7420
if ($env:GRIN_PORT -match '^\d+$') { $Port = [int]$env:GRIN_PORT }
$Url     = "http://127.0.0.1:$Port"

function Write-Step($m) { Write-Host "[boot] $m" -ForegroundColor Cyan }
function Write-OK($m)   { Write-Host "[ok]   $m" -ForegroundColor Green }
function Write-ErrX($m) { Write-Host "[err]  $m" -ForegroundColor Red }

function Stop-WithMessage($m) {
    if ($Background) {
        try {
            $logDir = Join-Path $Root 'logs'
            if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
            $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $m
            [IO.File]::AppendAllText((Join-Path $logDir 'bootstrap.log'), $line + [Environment]::NewLine)
        } catch { }
        exit 1
    }
    Write-ErrX $m
    Write-Host ''
    Read-Host 'Press Enter to exit' | Out-Null
    exit 1
}

# True when this app already answers on the port (its health reply names the
# install folder; another program on the same port does not).
function Test-AppRunning {
    try {
        $r = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200 -and $r.Content -match 'installRoot')
    } catch {
        return $false
    }
}

try {
    # --- Already running: just show the panel ---------------------------------
    # Checked before the elevation request, so opening the panel of a running
    # app (started at logon, or by an earlier double-click) asks for nothing.
    if (Test-AppRunning) {
        if (-not $Background) {
            Write-OK "Grin Node Desktop is already running - opening $Url"
            Start-Process $Url
        }
        exit 0
    }

    # --- Elevate --------------------------------------------------------------
    # The app registers, starts and stops Windows services, which needs an
    # Administrator token. Relaunching is safe here (unlike in install.ps1): the
    # elevated process runs this same local file, not a fresh download.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin  = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        if ($Background) {
            Stop-WithMessage 'Started in the background without Administrator rights; the logon task must run with highest privileges.'
        }
        Write-Step 'Administrator rights are needed - answer Yes to the Windows prompt...'
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        try {
            Start-Process -FilePath $powershell -Verb RunAs -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        } catch {
            Stop-WithMessage 'Elevation was declined or failed. Grin Node Desktop cannot manage services without Administrator rights.'
        }
        exit 0
    }

    # --- Verify Node.js -------------------------------------------------------
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-ErrX 'Node.js is not installed.'
        Write-Host ''
        Write-Host 'Run the installer first:' -ForegroundColor Yellow
        Write-Host '    irm https://grinnode.org/install | iex' -ForegroundColor White
        Stop-WithMessage 'Cannot start without Node.js.'
    }
    $nodeVersion = (node --version | Out-String).Trim()
    $nodeMajor = 0
    if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt $MinNode) {
        Stop-WithMessage "Node.js $nodeVersion is too old; version $MinNode or newer is needed. Update it (winget upgrade OpenJS.NodeJS.LTS, or https://nodejs.org) and start again."
    }

    # --- Install npm deps when package-lock.json changed ----------------------
    # The marker holds the SHA256 of the package-lock.json the installed modules
    # were built from. It lives inside node_modules, so it disappears with a
    # wiped or half-installed tree (npm ci deletes node_modules before
    # installing), and it differs after an update that changed the lock file.
    $LockFile = Join-Path $AppDir 'package-lock.json'
    $Marker   = Join-Path $AppDir 'node_modules\.grin-lock-hash'
    if (-not (Test-Path -LiteralPath $LockFile)) {
        Stop-WithMessage "$LockFile is missing. The install folder is incomplete; run the installer again."
    }
    $lockHash = (Get-FileHash -LiteralPath $LockFile -Algorithm SHA256).Hash
    $installed = ''
    if (Test-Path -LiteralPath $Marker) {
        $installed = ([IO.File]::ReadAllText($Marker)).Trim()
    }
    if ($installed -ne $lockHash) {
        Write-Step 'Installing Node dependencies...'
        Push-Location $AppDir
        try {
            # npm.cmd, not npm: the bare name resolves to npm.ps1, which a
            # group-policy execution policy refuses even under -ExecutionPolicy Bypass.
            npm.cmd ci --omit=dev
            $npmExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($npmExit -ne 0) {
            Stop-WithMessage "npm ci failed (exit code $npmExit). Check your internet connection and start again."
        }
        [IO.File]::WriteAllText($Marker, $lockHash)
        Write-OK 'Dependencies installed.'
    }

    # --- Launch the app -------------------------------------------------------
    Write-Step 'Starting Grin Node Desktop...'
    if (-not $Background) {
        Write-Host '       Keep this window open: closing it stops the panel (the nodes keep running).' -ForegroundColor Yellow
    }
    Push-Location $AppDir
    try {
        if ($Background) { node $Entry } else { node $Entry --open-browser }
        $nodeExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($nodeExit -ne 0) {
        Stop-WithMessage "Grin Node Desktop stopped with exit code $nodeExit. See the messages above and the logs folder."
    }
} catch {
    # Without this the elevated window closes at once and takes the reason with it.
    Stop-WithMessage "Unexpected error: $($_.Exception.Message)"
}
