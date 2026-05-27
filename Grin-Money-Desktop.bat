@echo off
:: Daily launcher — double-click to start the wallet.
:: First-time setup is done by install.ps1 (via the irm | iex one-liner).
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\bootstrap.ps1"
pause
