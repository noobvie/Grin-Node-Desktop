#Requires -Version 5.1
# Grin Node Desktop - one-liner installer
# Served at https://grinnode.org/install.ps1, and to PowerShell at:
#     irm https://grinnode.org/install | iex
# (https://grinnode.org/install hands curl/wget the Linux node toolkit installer
# instead; https://grin.money/install redirects there.)
#
# Runs ONCE on a fresh machine. Installs Git + Node.js, clones the repo,
# then hands off to scripts/bootstrap.ps1 (which launches the Node app).
#
# This file is ASCII-only on purpose: Windows PowerShell 5.1 reads a script
# without a BOM in the ANSI code page, where a multi-byte UTF-8 character can
# decode to a quote and break parsing.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

# The same /install URL serves Linux users a bash script; PowerShell 7 on Linux
# or macOS gets this file, which only works on Windows.
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'Grin Node Desktop is a Windows app. On a Linux server, run: curl -fsSL https://grinnode.org/install | sudo bash'
}

$REPO_URL  = 'https://github.com/noobvie/Grin-Node-Desktop.git'
$MIN_GIB   = 20
$MIN_NODE  = 20

function Write-Step($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "[ok]      $msg" -ForegroundColor Green }
function Write-Warn2($m)  { Write-Host "[warn]    $m"   -ForegroundColor Yellow }

# Native commands do not raise PowerShell errors; a non-zero exit code is the
# only failure signal, so it is checked after every winget / git / icacls call.
function Assert-ExitCode($what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what failed (exit code $LASTEXITCODE). Nothing further was changed; fix the problem above and run the installer again."
    }
}

# --- Install dir selection ----------------------------------------------------
# An existing install wins, wherever it is (D:\Grin first, then C:\Grin), so a
# second run updates it instead of cloning a fresh copy onto the other drive.
# Otherwise: D:\Grin, falling back to C:\Grin, with >= 20 GiB free.
function Select-InstallDrive {
    foreach ($letter in @('D', 'C')) {
        if (Test-Path -LiteralPath "${letter}:\Grin\.git") { return "${letter}:\Grin" }
    }
    foreach ($letter in @('D', 'C')) {
        $drive = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue
        if ($null -eq $drive) { continue }
        if ($drive.Free -lt ($MIN_GIB * 1GB)) { continue }
        return "${letter}:\Grin"
    }
    $report = Get-PSDrive C, D -ErrorAction SilentlyContinue |
        ForEach-Object { '{0}: {1:N1} GiB free' -f $_.Name, ($_.Free / 1GB) }
    throw "Need at least $MIN_GIB GiB free on D:\ or C:\. Found: $($report -join ', ')"
}

# --- Require Administrator ----------------------------------------------------
# No self-elevation: relaunching elevated would download the script again, so
# the code running as Administrator could differ from the copy the user read
# and checked. `return`, not `exit`: under `irm | iex` exit closes the window.
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$current).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warn2 'This installer needs an Administrator PowerShell.'
    Write-Host  '          Right-click PowerShell -> "Run as administrator", then run the same command again.' -ForegroundColor Yellow
    return
}

Write-Host ''
Write-Host '+--------------------------------------------------------+' -ForegroundColor Cyan
Write-Host '|  Grin Node Desktop - Installer                         |' -ForegroundColor Cyan
Write-Host '+--------------------------------------------------------+' -ForegroundColor Cyan
Write-Host ''

$INSTALL_DIR = Select-InstallDrive
Write-OK "Install dir: $INSTALL_DIR"

# --- winget helper ------------------------------------------------------------
# What counts is the program being usable afterwards, not winget's exit code:
# winget answers "already installed" with a non-zero code, and a program that
# is installed but missing from this session's PATH is found in $knownDir.
# --source winget keeps the Microsoft Store source (and its region and
# agreement failures) out of the lookup.
function Install-WithWinget($id, $command, $knownDir) {
    if (Test-Path -LiteralPath $knownDir) { $env:PATH = "$env:PATH;$knownDir" }
    if (Get-Command $command -ErrorAction SilentlyContinue) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is not available in this PowerShell, so $id cannot be installed automatically. Update 'App Installer' in the Microsoft Store (or install $id by hand), then run the installer again."
    }
    winget install --id $id -e --silent --source winget `
        --accept-source-agreements --accept-package-agreements
    $code = $LASTEXITCODE
    if (Test-Path -LiteralPath $knownDir) { $env:PATH = "$env:PATH;$knownDir" }
    if (Get-Command $command -ErrorAction SilentlyContinue) { return }
    if ($code -ne 0) {
        throw "winget install $id failed (exit code $code). Install $id by hand, then run the installer again."
    }
    throw "$id was installed but $command is not on PATH yet. Open a new Administrator PowerShell and run the installer again."
}

# --- 1. Git -------------------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing Git...'
    Install-WithWinget 'Git.Git' 'git' "$env:ProgramFiles\Git\cmd"
    Write-OK 'Git installed.'
} else {
    Write-OK 'Git already present.'
}

# --- 2. Node.js ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing Node.js LTS...'
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'node' "$env:ProgramFiles\nodejs"
    Write-OK 'Node.js installed.'
} else {
    Write-OK 'Node.js already present.'
}
$nodeVersion = (node --version | Out-String).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt $MIN_NODE) {
    throw "Node.js $nodeVersion is installed, but version $MIN_NODE or newer is needed. Update it (winget upgrade OpenJS.NodeJS.LTS, or https://nodejs.org), then run the installer again."
}

# --- 3. Clone or update repo --------------------------------------------------
if (Test-Path -LiteralPath (Join-Path $INSTALL_DIR '.git')) {
    Write-Step "Existing install found at $INSTALL_DIR - pulling latest..."
    git -C $INSTALL_DIR pull --ff-only
    Assert-ExitCode "git pull in $INSTALL_DIR"
} elseif (Test-Path -LiteralPath $INSTALL_DIR) {
    throw "$INSTALL_DIR already exists but is not a Grin Node Desktop install (it has no .git folder). Move or rename that folder, then run the installer again."
} else {
    Write-Step "Cloning to $INSTALL_DIR..."
    git clone $REPO_URL $INSTALL_DIR
    Assert-ExitCode "git clone to $INSTALL_DIR"
}
Write-OK 'Repository ready.'

# --- 4. Lock down the install dir ---------------------------------------------
# The node and Tor services run as LocalSystem from this folder (bin\nssm.exe,
# data\node-*\grin.exe). A folder created at a drive root inherits "Authenticated
# Users: Modify", which would let any local account replace those binaries and
# have its code run as SYSTEM at the next service start. Inheritance is removed
# and access granted only to Administrators (S-1-5-32-544), SYSTEM (S-1-5-18)
# and the installing user. SIDs are used throughout: the group names are
# localised, and icacls cannot map the account NAME of an Entra ID (AzureAD)
# or Microsoft-account sign-in back to its SID.
Write-Step "Restricting access to $INSTALL_DIR..."
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $INSTALL_DIR /inheritance:r /grant:r `
    '*S-1-5-32-544:(OI)(CI)F' `
    '*S-1-5-18:(OI)(CI)F' `
    "*$($current.User.Value):(OI)(CI)M" | Out-Null
Assert-ExitCode "icacls on $INSTALL_DIR"
Write-OK 'Only Administrators, SYSTEM and your account can change this folder.'

# --- 5. Start the panel at logon + desktop shortcut ---------------------------
# The node services start with Windows on their own; this brings the panel
# (http://127.0.0.1:7420) back as well. The task runs elevated in the user's
# session without a prompt, with no time limit (the default would stop the
# panel after 72 hours). Neither step is needed to run the app, so a failure
# here is a warning, not a stop.
$launcher  = Join-Path $INSTALL_DIR 'Grin-Node-Desktop.bat'
$bootstrap = Join-Path $INSTALL_DIR 'scripts\bootstrap.ps1'
try {
    $psExe     = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArgs  = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bootstrap`" -Background"
    $action    = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgs
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $current.Name
    $principal = New-ScheduledTaskPrincipal -UserId $current.Name -LogonType Interactive -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'Grin Node Desktop' -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-OK 'The panel will start by itself when you sign in to Windows.'
} catch {
    Write-Warn2 "Could not register the sign-in task: $($_.Exception.Message)"
    Write-Warn2 'The app still works; start it with Grin-Node-Desktop.bat after a restart.'
}
try {
    $desktop  = [Environment]::GetFolderPath('Desktop')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Grin Node Desktop.lnk'))
    $shortcut.TargetPath       = $launcher
    $shortcut.WorkingDirectory = $INSTALL_DIR
    $shortcut.Save()
    Write-OK 'Desktop shortcut created.'
} catch {
    Write-Warn2 "Could not create the desktop shortcut: $($_.Exception.Message)"
}

# --- 6. Hand off to daily launcher --------------------------------------------
Write-Step 'Launching app...'
& $launcher
