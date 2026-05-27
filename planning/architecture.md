# Architecture — Grin Money Desktop

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
| `install.ps1` | **Once**, from `irm https://grin.money/install \| iex`, before the repo exists locally | Self-elevate → `winget install git` → `winget install nodejs` → `git clone` → hand off to bootstrap.ps1 |
| `scripts/bootstrap.ps1` | **Every launch**, when user double-clicks the .bat | Verify Node, `npm install` on first run, exec `node app/server.js` |

That's the entire PS surface area. No menu, no logging library, no shared
helpers, no service control, no TOML editing. None of the PS pitfalls
from the old toolkit can apply because there's no PS code that touches
those things.

---

## 4. Storage layout on the user's machine

**All paths under one root** so "delete the folder" is a clean uninstall.
The repo and its runtime data live together; `.gitignore` excludes
runtime dirs from git so `git pull` for self-update stays clean.

```
%USERPROFILE%\Grin-Money-Desktop\           ← Install root (everything lives here)
│
├── README.md                               ┐
├── install.ps1                             │
├── Grin-Money-Desktop.bat                  │
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

**Why not `%LOCALAPPDATA%` for data?** Convention favours it, but
`%USERPROFILE%\Grin-Money-Desktop\` matches the user's mental model
("the wallet is in this one folder"). One folder = one uninstall. Easier
backups: zip the whole thing.

**Why `%USERPROFILE%` and not `C:\Grin\`?** Userprofile needs no Admin
for file writes. Admin is still required for Windows service
registration (NSSM), but only at install time — daily use never prompts
UAC after that.

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

| Service name | Wraps | Start type (default) | Purpose |
|---|---|---|---|
| `tor` | `tor.exe` | `auto` | SOCKS5 proxy on 9050; private send/receive |
| `GrinNode-Mainnet-Pruned` | `grin.exe server run` | `demand` | Mainnet pruned node |
| `GrinNode-Mainnet-Full` | `grin.exe server run` | `demand` | Mainnet full node (rare) |
| `GrinNode-Testnet-Pruned` | `grin.exe --testnet server run` | `demand` | Testnet node |

Service naming pattern: `GrinNode-<Network>-<Mode>` (capitalised).
See `app/lib/services/catalog.js` in [function-flows.md](function-flows.md).

**Start type meanings:**
- `auto` — starts on Windows boot
- `demand` — user (or the UI) explicitly starts it
- `disabled` — won't start, even manually

Default is `demand` for nodes because chain_data is bandwidth-heavy and
not every user wants it always running. Tor is `auto` because it's
lightweight and needed for sends.

**Why NSSM for grin.exe:** `grin.exe` has no native `--service install`
flag. NSSM (~300 KB, MIT) wraps it with proper Ctrl+C semantics — when
Windows tells the service to stop, NSSM gives grin 30 seconds to flush
chain_data cleanly, avoiding corruption. Pinned to NSSM 2.24 with SHA256
verification.

---

## 7. Bootstrap flow

### Path A — one-liner (recommended)

```
User opens PowerShell as Administrator and pastes:

  irm https://grin.money/install | iex

  ↓ downloads ~3 KB install.ps1 into memory (no file on disk yet)
  ↓ executes in current shell
  ↓
install.ps1:
  ├─ Force TLS 1.2
  ├─ Self-elevate if not Admin (re-runs the one-liner under RunAs)
  ├─ Pick install dir ($env:USERPROFILE\Grin-Money-Desktop by default)
  ├─ winget install Git.Git              ← if missing
  ├─ winget install OpenJS.NodeJS.LTS    ← if missing
  ├─ git clone https://github.com/noobvie/Grin-Money-Desktop.git $InstallDir
  └─ Launch $InstallDir\Grin-Money-Desktop.bat
       ↓
       Grin-Money-Desktop.bat → scripts\bootstrap.ps1 → node app\server.js
            ↓
            Browser opens http://127.0.0.1:7420/setup
            ↓
            Wizard streams progress for grin.exe / wallet / tor / chain_data
```

### Path B — ZIP / manual (no `iex`)

```
1. Click "Code → Download ZIP" on GitHub
2. Extract anywhere
3. Double-click Grin-Money-Desktop.bat
   └─ scripts\bootstrap.ps1
        ├─ Is Node.js on PATH? → install via winget if missing
        ├─ Is Admin? → relaunch with -Verb RunAs if not
        └─ node app\server.js
             ↓ same setup wizard as Path A
```

Path B skips git on first run — only needed for self-update later. UI
offers to install it then.

### Daily launch (both paths converge)

```
Double-click Grin-Money-Desktop.bat
  └─ scripts\bootstrap.ps1 (Node already present, ~1s)
       └─ node app\server.js
            └─ Dashboard (no wizard, services already in SCM)
```

---

## 8. Repo layout

```
Grin-Money-Desktop/
├── README.md                       Short, non-technical
├── install.ps1                     ~80 LOC, hosted at grin.money/install
├── Grin-Money-Desktop.bat          5-line daily launcher
├── .gitignore                      Excludes runtime dirs (bin/, data/, state/, logs/)
├── scripts/
│   └── bootstrap.ps1               ~50 LOC, verifies Node + execs server.js
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

## 9. Hosting `install.ps1` on grin.money

The `irm` one-liner only works if `https://grin.money/install` returns
the raw script body as `text/plain` (an HTML response would make `iex`
execute HTML — fails immediately).

### nginx route (added to the grin.money vhost)

```nginx
location = /install {
    default_type text/plain;
    alias /var/www/grin-money-desktop-installer/install.ps1;
    add_header Cache-Control "public, max-age=300";
    add_header X-Content-Type-Options "nosniff";
}

location = /install.ps1 {
    default_type text/plain;
    alias /var/www/grin-money-desktop-installer/install.ps1;
}
```

### Deploy mechanism

The Grin-Landing-Pages repo's `site_manager.sh` gains a dedicated menu
option (`G`) that pulls `install.ps1` from this repo and copies it to
`/var/www/grin-money-desktop-installer/`. Separate from the site-deploy
flow so yearly landing-page rollovers and weekly installer updates never
collide. See §10 for the two-repo coordination contract.

### Safety guards in the deploy

- **Signature check** — file must start with `#Requires -Version 5.1`
  before deploy. Guards against accidentally shipping the wrong file.
- **Atomic mv** — write to `install.ps1.new`, then `mv` over. Concurrent
  `irm` requests mid-deploy never see a half-written file.
- **Post-deploy curl smoke test** — fetch `https://grin.money/install`
  and verify the signature line came through. Catches misconfigured
  nginx, broken TLS, wrong path.

---

## 10. Two-repo coordination — Grin-Money-Desktop ↔ Grin-Landing-Pages

The two repos serve different audiences and cadences (landing page =
yearly; this repo = weekly). They stay separate. The seam is **one
nginx vhost + one deploy action** in site_manager.sh.

### What lives where

| Artifact | Repo | Why |
|---|---|---|
| `install.ps1` | Grin-Money-Desktop | Ships with the rest of the toolkit code |
| nginx vhost config for `grin.money` | Grin-Landing-Pages | Owns the domain's web infra |
| Landing page HTML | Grin-Landing-Pages | Already there |
| Install command snippet on landing page | Grin-Landing-Pages | Where users discover it |

### Integration touch points (three minimal additions)

1. **`site_manager.sh` menu option `G`** — *GrinMoney Desktop Installer*
   pulls `install.ps1` from this repo, copies to nginx-served location,
   smoke tests.
2. **nginx `/install` location block** in the `grin.money` vhost,
   opt-in per domain when running menu option 1 (add domain).
3. **"Get Grin Money Desktop" section** on `web/grin-money-2026/index.html`
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
NSSM needs Admin. install.ps1 self-elevates with `-Verb RunAs` at the
top so there's one UAC prompt, then the whole flow runs elevated.
Alternative (Node re-spawns itself elevated mid-flow) felt worse.

**R2 — Node.js install before launch**
`winget install OpenJS.NodeJS.LTS` works on Win10 1809+ with App
Installer present. Fallback: download the LTS MSI from `nodejs.org` and
`msiexec /i node-lts.msi /quiet /norestart`. install.ps1 needs to
handle both paths.

**R3 — Self-update of `bootstrap.ps1` itself**
If we ship a bug in `bootstrap.ps1`, users can't self-update through
Node (Node updates the JS, not the PS). Mitigation: keep `bootstrap.ps1`
so simple it has no logic to be buggy — just verify Node, exec server.

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

## 12. Open decisions (need answers before Phase 1 starts)

1. **Install dir**: `%USERPROFILE%\Grin-Money-Desktop\` (default in this
   doc) vs `C:\Grin\` / `D:\Grin\` (drive-root pattern, more visible but
   requires Admin for file writes)?
2. **Networks side-by-side**: support mainnet + testnet running
   simultaneously, or one at a time (swap via Settings)? Side-by-side
   needs more disk (~3 GB extra) but is harmless otherwise.
3. **Multiple wallets per network**: yes (matches the existing wallet
   registry pattern), or one wallet per network (simpler)?
4. **Service start type default**: `demand` (architecture's current
   answer — user clicks Start) vs `auto` (boot-start)?
5. **Tor default**: on or off in the wizard? Default `on` since private
   sends are the main draw of Grin.
6. **License**: README currently says MIT — confirm or pick alternative.

---

## 13. Grin API references

- **Wallet API tutorial**: <https://github.com/grincc/grin-wallet-api-tutorial>
- **Wallet API Rust docs**: <https://docs.rs/grin_wallet_api/latest/grin_wallet_api/>
- **grin-wallet repo**: <https://github.com/mimblewimble/grin-wallet>
- **grin node repo**: <https://github.com/mimblewimble/grin>
- **Official docs**: <https://docs.grin.mw>
- **Grin forum**: <https://forum.grin.mw>

Owner API v3 flow: `init_secure_api` → ECDH key exchange → `open_wallet`
→ AES-256-GCM encrypted calls.
Foreign API v2: Basic Auth + secret file, no ECDH.
