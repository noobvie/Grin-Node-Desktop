# Grin Money Desktop

Build your own Grin wallet on Windows — with a clean web interface, the
**official** [grin-wallet](https://github.com/mimblewimble/grin-wallet)
binary underneath, and no command line after the first install.

No Linux. No WSL. No coding required to use it.
But the whole thing is plain HTML / JavaScript / a tiny PowerShell launcher
— so if you ever want to customize, refactor, or learn how Grin works, every
piece is human-readable.

> **Work in progress.** Not ready for general use yet.

---

## Install

Open **PowerShell as Administrator** and paste this one line:

```powershell
irm https://grin.money/install | iex
```

That's it. The installer downloads Git, Node.js, and this repo for you, then
opens the wallet in your browser.

Prefer to see the script before running it? Open the same URL in a browser
first: <https://grin.money/install>.

### Manual install (no one-liner)

1. Click **Code → Download ZIP** on GitHub
2. Extract anywhere
3. Double-click `Grin-Money-Desktop.bat`

---

## What it does

- Downloads the official Grin node and wallet binaries (with SHA256 verification)
- Sets up Tor for private send/receive
- Runs a tiny local web server at <http://127.0.0.1:7420> for the wallet UI
- All your keys + chain data stay on your machine

---

## Customize / refactor

The whole codebase is intentionally small and readable:

- `install.ps1` — the one-liner installer (~80 lines)
- `scripts/bootstrap.ps1` — daily launcher, makes sure Node is present
- `app/` — Node.js server + web UI (everything else lives here)

See [planning/](planning/) for the architecture rationale.

---

## License

MIT — do what you want.
