# Architecture — Grin Node Desktop

Sibling docs:
- [coding-plan.md](coding-plan.md) — what to build, in what order
- [function-flows.md](function-flows.md) — per-function pseudocode

> **One-line goal:** PowerShell exists only to install Node.js. Everything
> else — binary downloads, chain_data, TOML patching, service registration,
> wallet operations, web UI — lives in Node.js.

---

## 1. Who this is for

- A user who wants their own Grin wallet on Windows
- Has heard of Grin but doesn't want to spin up a Linux VPS
- Comfortable double-clicking, not comfortable reading PowerShell
- May (or may not) want to learn how Grin works — code must stay legible
  enough that a curious user can read it

---

## 2. Layered architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser   — http://127.0.0.1:7420                                │
│            Setup wizard (first run) → Dashboard (daily use)      │
└─────────────────────────────────────────────────────────────────┘
                              │  HTTP + SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Node.js   — app/server.js                                        │
│            Express + Server-Sent Events                          │
│            ┌──────────────────────────────────────────────────┐  │
│            │ Installer  Services  Wallet  Node API  Setup     │  │
│            │ modules                                            │  │
│            └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │              │              │                │
        │              │              │                │
        ▼              ▼              ▼                ▼
┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────────┐
│ grin.exe │  │ grin-wallet  │  │ tor.exe  │  │ Windows SCM    │
│ (NSSM    │  │ (spawned     │  │ (native  │  │ (services.msc) │
│  service)│  │  listener)   │  │ service) │  │                │
└──────────┘  └──────────────┘  └──────────┘  └────────────────┘
        │                                            ▲
        ▼                                            │
   ┌─────────────┐                                   │
   │ chain_data  │                                   │
   │  on disk    │ ──────────────── managed by ──────┘
   └─────────────┘
```

**Invariant:** if Node.js can do it, Node.js does it. PowerShell exists
only because Node.js can't install itself.

---

## 3. PowerShell — what's left

Two tiny files, ~130 LOC combined:

| File | When it runs | What it does |
|---|---|---|
| `install.ps1` | **Once**, from `irm https://grinnode.org/install \| iex`, before the repo exists locally | Require Admin (stop otherwise) → `winget install git` → `winget install nodejs` → `git clone` → hand off to bootstrap.ps1 |
| `scripts/bootstrap.ps1` | **Every launch**, when user double-clicks the .bat | Relaunch itself elevated (`-Verb RunAs`) if not Administrator → verify Node → `npm ci` when `package-lock.json` changed (hash kept in `app\node_modules\.grin-lock-hash`) → `node app/server.js` |

That's the entire PS surface area. No menu, no logging library, no shared
helpers, no service control, no TOML editing. None of the PS pitfalls
from the old toolkit can apply because there's no PS code that touches
those things.

---

## 4. Storage layout on the user's machine

**Install root: `D:\Grin\` (preferred) or `C:\Grin\` (fallback).**
`install.ps1` picks the first of those two drives with at least **20 GiB
free**; it errors out with the free-space report if neither qualifies.
Drive-root paths are chosen over `%USERPROFILE%` so:
- Multi-GB chain_data doesn't bloat the user's profile / OneDrive
- Backups / re-imaging the system disk doesn't drag chain_data along
- The path is short, predictable, and visible (`D:\Grin\` shows up
  prominently in Explorer next to other drive contents)

The drive-root requires Admin for the *first* write — install.ps1
must be run from an Administrator PowerShell (it stops with a message
otherwise) so all subsequent setup steps inherit that token. Daily use
prompts UAC once per launch: `bootstrap.ps1` relaunches itself elevated,
because the app registers, starts and stops Windows services. After the
clone, install.ps1 removes inherited permissions from the install dir and
grants access to Administrators, SYSTEM and the installing user only — the
services run as LocalSystem from that folder, so no other account may be
able to replace a binary in it.

**All paths under one root** so "delete the folder" is a clean uninstall.
The repo and its runtime data live together; `.gitignore` excludes
runtime dirs from git so `git pull` for self-update stays clean.

```
D:\Grin\                                    ← Install root (or C:\Grin\ fallback)
│
├── README.md                               ┐
├── install.ps1                             │
├── Grin-Node-Desktop.bat                  │
├── scripts/                                │ tracked by git
│   └── bootstrap.ps1                       │ (source code)
├── app/                                    │
│   ├── server.js                           │
│   ├── package.json                        │
│   ├── lib/                                │
│   └── public/                             ┘
│
├── app/node_modules/                       ┐
├── bin/                                    │
│   ├── grin.exe                            │ NOT tracked by git
│   ├── grin-wallet.exe                     │ (downloaded binaries)
│   ├── nssm.exe                            │
│   └── tor/                                │
│       ├── tor.exe                         │
│       └── *.dll, pluggable_transports/    ┘
│
├── data/                                   ┐
│   ├── node-mainnet/                       │ ← Mainnet node
│   │   ├── grin-server.toml                │   - config
│   │   ├── .api_secret                     │   - Owner API secret (3413)
│   │   ├── .foreign_api_secret             │   - Foreign API secret (3413)
│   │   └── chain_data/                     │   - 3+ GB blockchain
│   │       ├── header_mmr/                 │
│   │       ├── kernel_mmr/                 │
│   │       ├── output_mmr/                 │
│   │       ├── txhashset/                  │
│   │       └── peer/                       │
│   │                                       │ NOT tracked by git
│   ├── node-testnet/                       │ (runtime state)
│   │   └── (same structure, smaller)       │
│   │                                       │
│   └── wallets/                            │ ← Per-wallet data
│       └── <walletName>/                   │
│           ├── grin-wallet.toml            │   - wallet config
│           ├── .foreign_api_secret         │   - Foreign API secret (3415/13415)
│           ├── .owner_api_secret           │   - Owner API secret (3420/13420)
│           ├── wallet_data/                │   - encrypted UTXO db + tx_proofs
│           └── tor/                        │   - per-wallet hidden service
│               ├── hostname                │     (this file holds the .onion)
│               ├── hs_ed25519_secret_key   │
│               └── hs_ed25519_public_key   ┘
│
├── state/                                  ┐
│   ├── app.json                            │ Top-level toolkit state
│   ├── binaries.json                       │ What's installed where
│   ├── nodes.json                          │ Per-node service + sync state
│   └── wallets.json                        │ Per-wallet registry
│
├── logs/                                   │ Rotating daily logs
│   ├── app-YYYY-MM-DD.log                  │ (14 days retention)
│   ├── GrinNode-Mainnet-Pruned.stdout.log  │ (per-service via NSSM)
│   └── GrinNode-Mainnet-Pruned.stderr.log  │
│
└── .tmp/                                   ┘ Download workspace (cleared on success)
```

**Where the big files go:**

| Asset | Path | Size |
|---|---|---|
| Mainnet chain_data | `data\node-mainnet\chain_data\` | ~3.2 GB (pruned), ~12 GB (full) |
| Testnet chain_data | `data\node-testnet\chain_data\` | ~500 MB (pruned) |
| Wallet UTXO db | `data\wallets\<name>\wallet_data\db\` | <10 MB typical |
| Tor hidden service keys | `data\wallets\<name>\tor\` | ~few KB per wallet |
| Binaries | `bin\` | ~80 MB total (grin + grin-wallet + tor + nssm) |
| node_modules | `app\node_modules\` | ~30 MB |
| **Total minimum free space at install** | | **20 GiB** (enforced by install.ps1) |

**Why 20 GiB?** Pruned mainnet + pruned testnet running side by side
(~3.7 GB chain data combined), plus binaries, plus growth headroom over
~6 months. Full-archive mainnet would need closer to 30 GiB but isn't
the default.

**Why `D:\Grin\` (or `C:\Grin\`) and not `%USERPROFILE%`?** Three
reasons:
1. Chain_data is multi-GB — keeping it out of the user profile means
   OneDrive sync, profile roaming, and system-disk backups don't pull
   it along.
2. The path stays short and predictable across users.
3. Re-imaging Windows doesn't wipe the wallet — `D:\Grin\` survives a
   fresh OS install if D: is a separate drive.

The trade-off: drive-root writes need Admin. Acceptable because
`install.ps1` runs once from an Administrator PowerShell, and NSSM service registration needs
Admin regardless.

---

## 5. Network conventions

Mainnet and testnet **run independently on different ports** so both can
exist side by side without conflict.

| | Mainnet | Testnet |
|---|---|---|
| Node Owner API | 3413 | 13413 |
| Node Foreign API | 3413 (same, different secret) | 13413 |
| Node P2P | 3414 | 13414 |
| Wallet Foreign API | 3415 | 13415 |
| Wallet Owner API | 3420 | 13420 |
| Currency label | GRIN | tGRIN |
| CLI flag | *(none)* | `--testnet` |

**Auth:** both node APIs use Basic Auth `grin:<secret>`. Secrets are
files on disk (see paths above), never sent over the network — only used
for localhost calls.

**Owner vs Foreign — which to call:**
- **Owner API** (`.api_secret`): `get_status` (tip + sync + peers),
  `get_connected_peers`, `validate_chain`, `compact_chain` — node
  management. Used by the dashboard + maintenance.
- **Foreign API** (`.foreign_api_secret`): `get_block`, `get_header`,
  `get_outputs`, `get_unspent_outputs`, `get_pool_size`,
  `push_transaction` — public chain queries. Used by wallets that
  connect to this node.

**Result unwrapping:** Grin serialises Rust `Result<T,E>` as
`{Ok: T}` / `{Err: E}` inside the JSON-RPC `result` field. The
`ownerCall()` / `foreignCall()` helpers in [function-flows.md §Phase 4](function-flows.md)
unwrap automatically. Direct access to `data.result` is a bug.

---

## 6. Service catalog (managed by NSSM)

Long-running components become Windows services so they survive reboot
and can be controlled from the web UI via `sc.exe`.

Both mainnet and testnet run **side by side by default** — separate
data dirs, separate ports, separate services. The disk space check (20
GiB) accounts for both pruned chains plus headroom.

| Service name | Wraps | Default start | Purpose |
|---|---|---|---|
| `tor` | `tor.exe` | `auto` | SOCKS5 proxy on 9050; private send/receive |
| `GrinNode-Mainnet-Pruned` | `grin.exe server run` | `auto` (user can switch to demand) | Mainnet pruned node |
| `GrinNode-Mainnet-Full` | `grin.exe server run` | user choice | Optional mainnet full node |
| `GrinNode-Testnet-Pruned` | `grin.exe --testnet server run` | user choice | Testnet node |

Service naming pattern: `GrinNode-<Network>-<Mode>` (capitalised).
See `app/lib/services/catalog.js` in [function-flows.md](function-flows.md).

**Start type meanings:**
- `auto` — starts on Windows boot
- `demand` — user (or the UI) explicitly starts it
- `disabled` — won't start, even manually

The Install dialog offers "Start with Windows", ticked by default, so a
node comes back by itself after a reboot (the Linux toolkit's default
too). Each node row carries a switch between `auto` and `demand`
(`POST /api/services/:name/start-type`). Tor defaults to `auto` — it's
lightweight and needed for private sends.

**The panel itself** is not a service. `install.ps1` registers a
scheduled task ("Grin Node Desktop", at sign-in, highest privileges, no
time limit) that runs `scriptsootstrap.ps1 -Background`: no browser,
no prompt, failures go to `logsootstrap.log`. Double-clicking the
.bat (or the desktop shortcut) while the panel already runs just opens
the browser, without a UAC prompt.

**Why NSSM for grin.exe:** `grin.exe` has no native `--service install`
flag. NSSM (~300 KB, MIT) wraps it with proper Ctrl+C semantics — when
Windows tells the service to stop, NSSM gives grin up to 300 seconds to
flush chain_data cleanly (the Linux toolkit's limit; at a Windows
shutdown the system's own `WaitToKillServiceTimeout` is shorter and
wins). Pinned to NSSM 2.24-101-g897c7ad, the build nssm.cc tells
Windows 10 1703+ users to take instead of release 2.24, with SHA256
verification.

---

## 7. Bootstrap flow

### Path A — one-liner (recommended)

```
User opens PowerShell as Administrator and pastes:

  irm https://grinnode.org/install | iex

  ↓ downloads ~3 KB install.ps1 into memory (no file on disk yet)
  ↓ executes in current shell
  ↓
install.ps1:
  ├─ Force TLS 1.2
  ├─ Stop with a message if not Admin (no self-elevation: a relaunch would
  │   re-download the script, so the elevated code could differ from the copy read)
  ├─ Pick install dir (an existing install on D:\Grin or C:\Grin wins;
  │   else D:\Grin preferred, C:\Grin fallback, min 20 GiB free)
  ├─ winget install Git.Git              ← if missing
  ├─ winget install OpenJS.NodeJS.LTS    ← if missing
  ├─ git clone https://github.com/noobvie/Grin-Node-Desktop.git $InstallDir
  │   (git pull if $InstallDir\.git exists; stop if the folder exists without it)
  ├─ icacls: Administrators + SYSTEM full, installing user modify, no inheritance
  ├─ every winget / git / icacls exit code is checked; a failure stops the script
  └─ Launch $InstallDir\Grin-Node-Desktop.bat
       ↓
       Grin-Node-Desktop.bat → scripts\bootstrap.ps1 → node app\server.js
            ↓
            Browser opens http://127.0.0.1:7420/setup
            ↓
            Wizard streams progress for grin.exe / wallet / tor / chain_data
```

### Path B — ZIP / manual (no `iex`)

```
1. Click "Code → Download ZIP" on GitHub
2. Extract anywhere
3. Double-click Grin-Node-Desktop.bat
   └─ scripts\bootstrap.ps1
        ├─ Is Admin? → relaunch itself with -Verb RunAs if not
        ├─ Is Node.js on PATH? → stop and point at the installer if missing
        ├─ npm ci if package-lock.json changed since the last install
        └─ node app\server.js
             ↓ same setup wizard as Path A
```

Path B skips git on first run — only needed for self-update later. UI
offers to install it then.

### Daily launch (both paths converge)

```
Double-click Grin-Node-Desktop.bat
  └─ scripts\bootstrap.ps1 (UAC prompt, Node already present, ~1s)
       └─ node app\server.js
            └─ Dashboard (no wizard, services already in SCM)
```

---

## 8. Repo layout

The authoritative tree, per-file size limit and module interfaces are in
[module-layout.md](module-layout.md); the Linux Script 01 behaviour this app mirrors is in
[linux-toolkit-parity.md](linux-toolkit-parity.md). The sketch below is the top level only.

```
Grin-Node-Desktop/
├── README.md                       Short, non-technical
├── install.ps1                     ~80 LOC, hosted at grinnode.org/install
├── Grin-Node-Desktop.bat          5-line daily launcher
├── .gitignore                      Excludes runtime dirs (bin/, data/, state/, logs/)
├── scripts/
│   └── bootstrap.ps1               ~100 LOC, elevates, verifies Node + deps, runs server.js
├── app/
│   ├── package.json                express + tar + yauzl + @iarna/toml + simple-git
│   ├── server.js                   Express entry point — wires routers, opens browser
│   ├── lib/
│   │   ├── installer/              binaries.js, chaindata.js, toml.js, github.js, node-config.js
│   │   ├── services/               sc.js, nssm.js, catalog.js
│   │   ├── wallet/                 owner-api.js (ECDH), foreign-api.js, registry.js
│   │   ├── node/                   api-client.js (Owner + Foreign for grin node)
│   │   ├── api/                    Express routers: setup, node, wallet, services, update
│   │   └── util/                   sse.js, log.js, state.js, paths.js, download.js, extract.js
│   └── public/
│       ├── index.html              Dashboard (post-setup home)
│       ├── setup/                  Wizard pages (welcome, network, binaries, …, done)
│       └── js/                     Plain ES modules per panel (no framework)
└── planning/
    ├── architecture.md             (this file)
    ├── coding-plan.md              Phase-by-phase build plan
    └── function-flows.md           Per-function pseudocode
```

---

## 9. Hosting `install.ps1` on grinnode.org

The `irm` one-liner only works if the URL returns the raw script body as
`text/plain` (an HTML response would make `iex` execute HTML — fails
immediately).

`https://grinnode.org/install` is shared with the Linux node toolkit and
answers by User-Agent: PowerShell (5.1 and 7) gets `install.ps1`, curl/wget
get the toolkit's `install.sh`, browsers get a help page. Fixed URLs
`/install.ps1` and `/install.ps1.sha256` serve the script and its checksum
to anyone. `https://grin.money/install` answers 301 to grinnode.org, so the
older one-liner keeps working. All responses carry `Cache-Control: no-cache`
so a cache (Cloudflare) never hands one client's body to another.

### Deploy mechanism

The Grin-Landing-Pages repo's `site_manager.sh` option `G` reads
`deploy/installer.conf`, pulls each installer from its repo's branch,
copies it to `/var/www/grin-installers/`, and writes the nginx side itself
(User-Agent map, location snippets, vhost includes; rolled back if
`nginx -t` fails). Separate from the site-deploy flow so yearly
landing-page rollovers and weekly installer updates never collide. See §10
for the two-repo coordination contract.

### Safety guards in the deploy

- **Marker check** — `#Requires -Version 5.1` must be a whole line within
  the first five lines before deploy. Guards against shipping the wrong
  file or an error page.
- **Atomic mv** — write to a temp file, then `mv` over. Concurrent `irm`
  requests mid-deploy never see a half-written file.
- **Post-deploy smoke test** — fetch `/install` with PowerShell 5.1 and 7
  User-Agents plus `/install.ps1`, verify the marker, the SHA256 and the
  no-cache header. Catches misconfigured nginx, a stale cache, broken TLS.

---

## 10. Two-repo coordination — Grin-Node-Desktop ↔ Grin-Landing-Pages

The two repos serve different audiences and cadences (landing page =
yearly; this repo = weekly). They stay separate. The seam is **one
nginx vhost + one deploy action** in site_manager.sh.

### What lives where

| Artifact | Repo | Why |
|---|---|---|
| `install.ps1` | Grin-Node-Desktop | Ships with the rest of the toolkit code |
| nginx vhost config for `grin.money` | Grin-Landing-Pages | Owns the domain's web infra |
| Landing page HTML | Grin-Landing-Pages | Already there |
| Install command snippet on landing page | Grin-Landing-Pages | Where users discover it |

### Integration touch points (three minimal additions)

1. **`site_manager.sh` menu option `G`** — *GrinMoney Desktop Installer*
   pulls `install.ps1` from this repo, copies to nginx-served location,
   smoke tests.
2. **nginx `/install` location block** in the `grin.money` vhost,
   opt-in per domain when running menu option 1 (add domain).
3. **"Get Grin Node Desktop" section** on `web/grin-money-2026/index.html`
   showing the one-liner.

### Release workflow

```
1. (this repo) Develop + test changes locally
2. (this repo) Tag a release:  git tag v2026.06.01 && git push --tags
3. (Grin-Landing-Pages, on VPS) sudo ./site_manager.sh --action deploy-installer
       └─ Pulls latest, copies install.ps1, smoke tests
4. Done — next visitor's one-liner gets the new version.
```

Existing installs auto-update through the web UI (Phase 9, separate
path — uses GitHub directly, not grin.money).

### Considered + rejected

- **Monorepo / submodule** — Different audiences, different cadences.
  Coupling neither repo needs.
- **GitHub Action that auto-deploys** to grin.money on push to main —
  `install.ps1` is the most security-sensitive file in the system.
  Anyone running the one-liner grants it Admin in their shell. A
  deliberate manual deploy gate is worth the friction.

---

## 11. Risks & open questions

**R1 — Admin elevation for service registration**
NSSM needs Admin. install.ps1 requires an Administrator PowerShell and
stops otherwise (it used to self-elevate with `-Verb RunAs`, but that
re-downloaded the script, so the elevated code was not the copy the user
had read). The whole flow then runs elevated.
`scripts/bootstrap.ps1` does self-elevate on every launch: it relaunches
the same local file, so the objection above does not apply. If elevation
is declined the launcher stops; if the server is started some other way
without an Administrator token, `/api/health` reports `elevated: false`
and the UI shows a banner.
Alternative (Node re-spawns itself elevated mid-flow) felt worse.

**R2 — Node.js install before launch**
`winget install OpenJS.NodeJS.LTS` works on Win10 1809+ with App
Installer present. Fallback: download the LTS MSI from `nodejs.org` and
`msiexec /i node-lts.msi /quiet /norestart`. install.ps1 needs to
handle both paths.

**R3 — Self-update of `bootstrap.ps1` itself**
If we ship a bug in `bootstrap.ps1`, users can't self-update through
Node (Node updates the JS, not the PS). Mitigation: keep `bootstrap.ps1`
small — elevate, verify Node, install dependencies when the lock file
changed, run the server.

**R4 — Cold-start UX during 3 GB chain_data download**
Setup wizard must show progress, ETA, and survive page refresh. SSE
covers the active session; the resumable `Range`-based download in
`util/download.js` covers the case where the user closes the wizard and
comes back later.

**R5 — Antivirus / SmartScreen**
Defender sometimes flags `irm | iex` from non-Microsoft domains and
sometimes flags `grin.exe`. NSSM-wrapped services run under LocalSystem
and avoid some heuristics. Plan: submit `install.ps1` to Microsoft for
review (free, ~3 days) once it's stable. Document Defender exclusion
steps in the UI as a fallback.

**R6 — Resume + hash on multi-GB chain_data**
`util/download.js` re-hashes the partial `.part` file from byte 0 on
resume, because we can't trust untrusted bytes without verifying. For
chain_data this could mean re-reading several GB. **Open:** persist
intermediate hash state across resumes. Defer until proven slow in
practice.

---

## 12. Decisions made (2026-05-26)

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Install dir: `D:\Grin\` preferred, `C:\Grin\` fallback, 20 GiB minimum** | Drive-root keeps chain_data off the user profile / OneDrive; survives OS reimage if D: is a separate disk. Hard error if neither drive has 20 GiB. |
| 2 | **Networks side-by-side** — mainnet + testnet run simultaneously | Separate services, separate ports, separate data dirs. 20 GiB minimum already accounts for both pruned chains. |
| 3 | **Multiple wallets per network: yes** | More flexible; matches the existing wallet registry shape (`wallets.json` is already an array). UI gains a wallet picker. |
| 4 | **Service start type: user-controlled (auto or demand)** | Install dialog asks per node, `auto` ticked by default; a switch on each node row changes it later. |
| 5 | **Tor default: on** | Private sends are Grin's main draw; users opting out is the rarer path. UI has a clear "disable Tor" switch for users who want to. |
| 6 | **License: Apache 2.0** | Permissive (anyone can use / fork / build on top), industry-standard for modern OSS projects, and adds an explicit patent grant that MIT lacks. See [LICENSE](../LICENSE). |

---

## 13. Scope — what we don't build

These are **explicit non-goals.** Listed here so future contributors
have a clear answer to "why isn't there X?" and so feature creep is
easy to push back on.

### Storage / install

- **No user-pickable chain_data location.** `install.ps1`'s automatic
  `D:\` → `C:\` selection (with the 20 GiB check) is the only choice.
  Letting users pick the path opens too many footguns: OneDrive-synced
  folders silently uploading chain_data, removable drives that vanish
  mid-sync, network shares with catastrophic latency, paths with
  spaces/non-ASCII that break `grin.exe --top_level_dir` quoting in
  edge cases, and the perennial "I formatted D: and now the wallet
  won't start." Power users who genuinely need a custom path can pass
  `-InstallDir` to install.ps1 manually (not exposed in the one-liner).
- **No `%USERPROFILE%` install option.** Decided explicitly to keep
  chain_data out of OneDrive's reach. See [architecture.md §4](#4-storage-layout-on-the-users-machine).
- **No "move chain_data to another drive" UI.** Adds complexity for a
  feature exercised once per user lifetime. Manual move + path update
  is documented for users who need it.

### Wallet features

- **No mobile app.** Desktop only. The local web UI is the boundary.
- **No multi-currency.** Grin only. No BTC, no LTC, no anything-else.
- **No built-in exchange / atomic swap.** Out of scope; link out to
  Grin community resources if needed.
- **No hardware wallet integration (v1).** `grin-wallet` doesn't have
  upstream Trezor / Ledger support. Revisit only if upstream lands it.
- **No cloud sync, hosted backup, or remote wallet storage.** The
  whole point is local custody.
- **No browser extension version.** Adds attack surface and a second
  codebase to maintain. The local-server boundary is already minimal.
- **No KYC, identity verification, or compliance tooling.** Out of
  scope, and opens legal liability the project doesn't want.

### Operations / telemetry

- **No analytics, no telemetry, no crash reporting** sent off-machine
  by default. See [security-model.md §7](security-model.md#7-logging-and-telemetry-policy).
- **No "always-on" background service** mode. The wallet runs only
  while the user has it open. (The grin **node** can be an always-on
  service via NSSM; the wallet UI process is foreground only.)
- **No auto-update.** Self-update is user-initiated through the UI.
  Wallets that update silently can ship a bug that breaks user funds —
  we keep the user in the loop.

### Process

- **No beta / nightly release channel** for v1. Single stable
  channel. Resist adding a beta until there are >100 users + a clear
  pre-release tester pool.
- **No public bug bounty program (v1).** Vulnerability reports
  acknowledged with credit, but no monetary rewards until project has
  funding for it. See [SECURITY.md](../SECURITY.md).

If you want to argue for moving any of these into scope, open a
discussion before opening a PR — moving non-goals into scope changes
the architecture, not just the code.

---

## 14. Grin API references

- **Wallet API tutorial**: <https://github.com/grincc/grin-wallet-api-tutorial>
- **Wallet API Rust docs**: <https://docs.rs/grin_wallet_api/latest/grin_wallet_api/>
- **grin-wallet repo**: <https://github.com/mimblewimble/grin-wallet>
- **grin node repo**: <https://github.com/mimblewimble/grin>
- **Official docs**: <https://docs.grin.mw>
- **Grin forum**: <https://forum.grin.mw>

Owner API v3 flow: `init_secure_api` → ECDH key exchange → `open_wallet`
→ AES-256-GCM encrypted calls.
Foreign API v2: Basic Auth + secret file, no ECDH.
