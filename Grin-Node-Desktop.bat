@echo off
:: Daily launcher - double-click to start the app.
:: First-time setup is done by install.ps1 (via the irm | iex one-liner).
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\bootstrap.ps1"
:: bootstrap.ps1 waits for Enter on the errors it reports itself; this pause
:: keeps the window open when it fails any other way (a parse error exits 1).
:: A clean exit (panel opened, or handed over to the elevated window) closes.
if errorlevel 1 pause
