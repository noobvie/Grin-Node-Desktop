# Coding Plan — From Zero to Working Wallet

Sibling to [architecture.md](architecture.md). Architecture says *what* and
*why*; this doc says *what to code, in what order, and how to verify each
step before moving on*.

> **Principle**: every phase must end with something **demonstrable** — a
> page in the browser, a binary on disk, a service in the SCM. If a phase
> ends with only "library code, not used yet," the order is wrong.

---

## Phase 0 — Skeleton  (DONE)

Already in place:
- Repo layout, [README.md](../README.md), [.gitignore](../.gitignore)
- [install.ps1](../install.ps1) — one-liner installer (skeleton)
- [Grin-Node-Desktop.bat](../Grin-Node-Desktop.bat) + [scripts/bootstrap.ps1](../scripts/bootstrap.ps1)
- [app/server.js](../app/server.js) — Express on 127.0.0.1:7420
- [app/public/index.html](../app/public/index.html) — proves the launcher → Node → browser chain works

**Demonstrable**: double-click `.bat` → browser opens → hello page shows
`{"ok":true,"version":"0.0.1"}`.

---

## Phase 1 — Foundation Plumbing

No Grin code yet. Build the four mechanisms every later phase depends on:
**SSE**, **logging**, **state**, **download**.

### Step 1.1 — SSE pipe (server → browser progress)

**Goal**: any long-running task in Node can emit progress events that the
browser receives in real time without polling.

**New files**:
- `app/lib/util/sse.js`

**Logic**:
```
SSE manager keeps an array of connected response streams.
Public methods:
  - subscribe(req, res)  → attaches client, sends keep-alive every 25s
  - emit(event, data)    → writes to all subscribers as "event: X\ndata: JSON\n\n"
  - close(res)           → on client disconnect, remove from array
Server-side, any module imports the manager and calls emit('install-progress', {…}).
Browser-side, EventSource('/api/events') receives every emit.
```

**Express integration**:
- `GET /api/events` — `Content-Type: text/event-stream`, calls `subscribe`

**Verify**: hit `/api/events` with curl + run a test emit from a debug
endpoint → curl prints the event.

---

### Step 1.2 — Unified logger

**Goal**: one `log()` call writes to (a) console, (b) rotating log file, (c)
SSE if an interactive client is attached.

**New files**:
- `app/lib/util/log.js`

**Logic**:
```
log(level, scope, msg, meta?)
  ├─ console.log: [HH:MM:SS] [level] [scope] msg
  ├─ append to D:\Grin\logs\app-YYYY-MM-DD.log
  └─ sse.emit('log', {ts, level, scope, msg, meta})
levels: debug | info | warn | error
rotation: new file daily, keep last 14
```

**Why "scope"**: lets the UI filter ("show me only installer logs") without
parsing free-text messages.

**Verify**: call `log('info','test','hello')` in `server.js` startup —
appears in console, appears in log file, appears in any open SSE stream.

---

### Step 1.3 — State files & schema

**Goal**: persistent state lives in JSON files alongside the install, with
a documented schema and atomic writes.

**New files**:
- `app/lib/util/state.js` — generic `readState(name)` / `writeState(name,obj)`
- `app/lib/util/paths.js` — well-known paths (install root, log dir, data dir)

**State files** (all under `D:\Grin\state\`):
| File | Schema (top-level keys) | Purpose |
|---|---|---|
| `app.json` | `{ version, firstRunComplete, network: 'mainnet'\|'testnet' }` | Global toolkit state |
| `binaries.json` | `{ grin: {version, path, sha256}, grinWallet: {...}, tor: {...}, nssm: {...} }` | What's installed where |
| `nodes.json` | `{ nodes: [ {network, mode, dir, serviceName, installed, lastSyncHeight} ] }` | Per-node state |
| `wallets.json` | `{ wallets: [ {name, network, dir, foreignPort, ownerPort} ] }` | Per-wallet state |

**Atomic write**: write to `<file>.tmp` → `fs.renameSync` over real file.
Never corrupts on crash mid-write.

**Verify**: write/read round-trip preserves data; killing process mid-write
leaves the previous file intact.

---

### Step 1.4 — Download utility

**Goal**: stream a remote file to disk with SHA256 verification, retry on
transient failure, progress events to SSE.

**New files**:
- `app/lib/util/download.js`

**Logic**:
```
download({ url, dest, sha256?, label?, onProgress? })
  ├─ HEAD request → get content-length
  ├─ https.get → pipe response to fs.createWriteStream(dest + '.part')
  ├─ on each chunk: bytes += chunk.length; call onProgress({bytes,total,pct})
  │     onProgress default = sse.emit('download-progress', {label, bytes, total, pct})
  ├─ on response 'end':
  │     if sha256 provided → crypto.createHash('sha256').update(file).digest('hex')
  │     mismatch → throw, delete .part
  │     match    → rename .part → final dest
  └─ retry up to 3× on network error (3s backoff)
```

**Verify**: download `https://nssm.cc/release/nssm-2.24.zip` with the known
SHA256 from architecture.md §2.1. Progress events appear in `/api/events`.
Tampering with the SHA constant causes a verification failure.

---

### Step 1.5 — Archive extractor

**Goal**: extract `.zip` and `.tar.gz` archives natively, without shelling
out to PowerShell or relying on the system's `tar.exe`.

**New files**:
- `app/lib/util/extract.js`

**Logic**:
```
extract({ archive, dest, format? })
  format inferred from extension if omitted
  ├─ .zip → yauzl  (or built-in zlib + simple zip parser)
  ├─ .tar.gz → tar (npm package)
  └─ progress events: file-by-file count + bytes
```

**Verify**: extract the NSSM zip from Step 1.4 → `dest/win64/nssm.exe`
exists and runs (`nssm.exe --version`).

---

### Phase 1 Done When

- `npm install` in `app/` succeeds (deps: `tar`, `yauzl`, no others yet)
- Hit `/api/dev/test-download` (temporary debug endpoint) → NSSM downloads,
  SHA-verifies, extracts, and `nssm.exe --version` prints in console
- `app/public/index.html` shows live progress via SSE during the download
- `app.log` shows the same events with timestamps

After Phase 1, every later phase has the tools it needs and stops growing
the foundation.

---

## Phase 2 — Binary Installer

Goal of phase: a fresh install can place `grin.exe`, `grin-wallet.exe`,
`tor.exe`, and `nssm.exe` on disk, all SHA256-verified, with config files
patched to working defaults.

### Step 2.1 — Install paths & layout

**New files**:
- Constants added to `app/lib/util/paths.js`

**Install root**: `D:\Grin\` preferred, `C:\Grin\` fallback. Selected
once by `install.ps1` (which enforces the 20 GiB minimum-free check).
Node reads it via `path.resolve(__dirname, '..', '..', '..')` — no
hard-coded drive letters in JS.

**Layout written**:
```
D:\Grin\                       ← or C:\Grin\ if D: lacks 20 GiB
├── (repo files: app/, scripts/, install.ps1, README.md, …)
├── bin\
│   ├── grin.exe
│   ├── grin-wallet.exe
│   ├── nssm.exe
│   └── tor\
│       ├── tor.exe
│       └── *.dll
├── data\
│   ├── node-mainnet\          ← chain_data + grin-server.toml + secrets
│   ├── node-testnet\          (runs side-by-side with mainnet)
│   └── wallets\<name>\        ← per-wallet (multiple per network OK)
├── state\                     ← JSON files (Step 1.3)
└── logs\
```

Decision recorded in [architecture.md §12](architecture.md#12-decisions-made-2026-05-26).

---

### Step 2.2 — GitHub release lookup

**New files**:
- `app/lib/installer/github.js`

**Logic**:
```
latestRelease(owner, repo, assetPattern)
  GET https://api.github.com/repos/<owner>/<repo>/releases/latest
  return { tag, asset: {name, url, size, sha256? } }
```

**Targets**:
- `mimblewimble/grin` → asset matching `grin-v.*-win-x86_64.zip`
- `mimblewimble/grin-wallet` → asset matching `grin-wallet-v.*-win-x86_64.zip`

**Risk**: GitHub releases for grin sometimes lack pre-computed SHA256.
**Mitigation**: compute SHA256 after download, store in `binaries.json`,
display to user. (Verification across reinstalls becomes "matches what we
recorded on first install.")

---

### Step 2.3 — grin.exe + grin-wallet.exe installer

**New files**:
- `app/lib/installer/binaries.js`

**Logic per binary**:
```
installBinary(name)
  ├─ Read binaries.json — if already installed at expected path + version, skip
  ├─ latestRelease() → URL, version
  ├─ download() → temp zip
  ├─ extract() → temp dir
  ├─ locate inner .exe (zips contain a versioned subfolder)
  ├─ copy to %INSTALL%\bin\<name>.exe
  ├─ record { version, path, sha256, installedAt } in binaries.json
  └─ sse.emit('binary-installed', {name, version})
```

**API surface**:
- `POST /api/setup/install-binaries` → starts all four (grin, grin-wallet,
  tor, nssm). Idempotent — re-running skips installed ones unless `?force=1`.

---

### Step 2.4 — tor.exe installer

**Source**: Tor Browser bundle is huge; we want the Expert Bundle.
- URL pattern: `https://archive.torproject.org/tor-package-archive/torbrowser/<ver>/tor-expert-bundle-windows-x86_64-<ver>.tar.gz`
- Latest URL is brittle. Pin a known-good version + SHA256 in code.
- Auto-update logic: separate, manual via UI.

---

### Step 2.5 — nssm.exe installer

**Source**: pinned to `https://nssm.cc/release/nssm-2.24.zip` with the
SHA256 from architecture.md §10 (already known-good).

---

### Step 2.6 — TOML patch helpers

**New files**:
- `app/lib/installer/toml.js`

**Logic**:
```
patchToml(file, mutations)
  - mutations: { 'server.api_http_addr': '127.0.0.1:13413', ... }
  - reads file with @iarna/toml
  - applies mutations
  - writes back with same lib (preserves order where possible)
  - never writes UTF-16 BOM (Buffer.from(str,'utf8') only)
```

**Why dotted paths**: matches grin-server.toml's nested structure
(`[server.p2p_config]` → `server.p2p_config.host`).

---

### Step 2.7 — Per-network config generator

**New files**:
- `app/lib/installer/node-config.js`

**Logic**:
```
generateNodeConfig({ network, mode, dataDir })
  ├─ Run `grin server config` in dataDir → produces default grin-server.toml
  ├─ patchToml() with:
  │     - network-specific ports (3413/3414 vs 13413/13414)
  │     - data dir paths
  │     - api_secret_path, foreign_api_secret_path
  │     - pruning flags if mode === 'pruned'
  │     - p2p host left at grin's default "::" (dual-stack inbound; linux-toolkit-parity.md §2)
  └─ generate .api_secret + .foreign_api_secret if missing (crypto.randomBytes(32).toString('hex'))
```

---

### Phase 2 Done When

- `POST /api/setup/install-binaries` from the browser → all four binaries
  land in `bin/`, SHA-verified, recorded in `binaries.json`
- `POST /api/setup/configure-node` with `{network:'testnet',mode:'pruned'}`
  generates a working `grin-server.toml` under `data/node-testnet/`
- Manually running `bin/grin.exe --testnet server run` from the data dir
  starts a node and begins syncing (no crash, listens on 13413/13414)

---

## Phase 3 — Service Management

Goal: register the binaries as Windows services so they survive reboot and
can be started/stopped from the web UI.

### Step 3.1 — sc.exe wrapper

**New files**: `app/lib/services/sc.js`

```
sc.query(name)    → { exists, state: 'running'|'stopped'|..., startType }
sc.start(name)
sc.stop(name)
sc.delete(name)
```

Wraps `child_process.execFile('sc.exe', [...])`. Parses Windows' `KEY:VALUE`
output into objects.

---

### Step 3.2 — NSSM wrapper

**New files**: `app/lib/services/nssm.js`

```
nssm.install(name, exePath, args)
nssm.setParams(name, { AppDirectory, AppStderr, AppStdout, AppExit, ... })
nssm.remove(name, confirm=true)
```

Wraps `child_process.execFile(nssmPath, [...])`. NSSM is verbose; the
wrapper hides its `[SC] OpenService FAILED` chatter when the service
doesn't exist (expected during status checks).

---

### Step 3.3 — Service catalog

**New files**: `app/lib/services/catalog.js`

```
serviceName({network, mode}) = `GrinNode-${cap(network)}-${cap(mode)}`
  → "GrinNode-Mainnet-Pruned"
nodeServiceFor({network, mode}) = {
  name,
  exe:  %INSTALL%/bin/grin.exe,
  args: network==='testnet' ? ['--testnet','server','run'] : ['server','run'],
  cwd:  %INSTALL%/data/node-${network},
  ...
}
```

(Mirrors architecture.md §2.2 from the v3 plan.)

---

### Step 3.4 — Service install endpoint

```
POST /api/services/install
  body: { network, mode }
  ├─ if already installed → 409
  ├─ catalog.nodeServiceFor(...)
  ├─ nssm.install(name, exe, args)
  ├─ nssm.setParams(name, { AppDirectory: cwd, AppStdout: log, AppExit: 'Restart' })
  ├─ sc.config(name, startType: 'demand')   ← default mode
  └─ update nodes.json
```

---

### Step 3.5 — Start/stop/status endpoints

```
POST /api/services/start  { name }  → sc.start(name)
POST /api/services/stop   { name }  → sc.stop(name)
GET  /api/services        → catalog.allKnown().map(sc.query)
GET  /api/services/:name  → sc.query(name)
```

---

### Phase 3 Done When

- Browser button "Install Testnet Pruned Node as Service" → service
  appears in `services.msc`, runs `grin.exe --testnet server run` cleanly
- "Start" button → node listens on 13413/13414; "Stop" → graceful Ctrl+C
  shutdown via NSSM (no chain_data corruption visible on next start)
- `nodes.json` reflects installed/running state

---

## Phase 4 — Node Integration

Goal: the UI shows live node sync status pulled from the node's API, and
can download chain data to fast-forward the initial sync.

### Step 4.1 — Owner API client

**New files**: `app/lib/wallet/node-owner-api.js`
(Node Owner API lives under `lib/node/`; wallet Owner API under `lib/wallet/`.)

```
ownerApi(network).call(method, params)
  ├─ Read .api_secret from data/node-${network}/
  ├─ Basic auth: grin:<secret>
  ├─ POST http://127.0.0.1:<port>/v2/owner with JSON-RPC
  ├─ Unwrap result: {Ok: T} → T,  {Err: E} → throw
  └─ return T
helpers:
  getStatus()
  getConnectedPeers()
  validateChain()
```

Note: prefer `get_status` over `get_tip` per architecture's API table —
`get_tip` returns "Method not found" in practice on the Owner API.

---

### Step 4.2 — Foreign API client

`app/lib/wallet/node-foreign-api.js`

Same shape as Owner API, but Foreign API + `foreign_api_secret_path`.
Methods: `getBlock(height)`, `getHeader(height|hash)`, `getOutputs`,
`getUnspentOutputs`, `pushTransaction`.

---

### Step 4.3 — Node status endpoint

```
GET /api/node/:network/status
  → {
      installed: true,
      running:   true,
      synced:    false,
      tipHeight: 2847102,
      networkHeight: 2848341,
      syncProgress: { header_pct: 100, body_pct: 87.3 },
      connections: 8,
      version: "5.4.0"
    }
```

UI polls this every 3s while the dashboard is open.

---

### Step 4.4 — Chain data download

**New files**: `app/lib/installer/chaindata.js`

**Logic**:
```
downloadChainData({ network })
  ├─ Resolve archive URL from a known mirror list (architecture-defined)
  ├─ download() — HUGE file, supports resume via HTTP Range
  ├─ extract() → data/node-${network}/chain_data/
  ├─ Verify presence of expected subdirs (header_mmr, kernel_mmr, output_mmr, txhashset)
  └─ sse.emit('chaindata-installed', {network})
```

**Resume**: if `chain_data.tar.gz.part` exists, send `Range: bytes=N-`. If
mirror doesn't support Range, fall through to fresh start with a warning.

---

### Step 4.5 — Sync progress UI

- Browser panel polls `/api/node/:network/status`
- Two progress bars: headers %, body %
- Tooltip with connection count + peer list (from a separate endpoint hit
  on hover)

---

### Phase 4 Done When

- Fresh install → "Download chain_data" button → 3.2 GB streams with
  progress bar + ETA
- After download, start service → sync from ~yesterday to tip in minutes
  (not days)
- Dashboard shows live `tipHeight` increasing every ~60s

---

## Phase 5 — Wallet Integration

Goal: user can create a wallet, see balance, send, receive.

### Step 5.1 — Wallet init wizard

**Endpoints**:
```
POST /api/wallets/create   { name, network, passphrase }
POST /api/wallets/recover  { name, network, passphrase, seedWords[] }
```

Flow:
```
1. mkdir data/wallets/<name>/
2. spawn grin-wallet --top_level_dir=<dir> init -p <passphrase>
   (--testnet flag if network)
3. capture stdout to extract seed words
4. patchToml grin-wallet.toml — set foreign/owner ports, api_secret_paths
5. register in wallets.json
6. return seed words to UI (one-time display, with confirmation step)
```

Security: passphrase **never** goes to disk. Lives only in
`sessions.get(walletName).passphrase`. A prior implementation cached it
in `.wallet_pass` for convenience — explicitly avoided here because any
local user with read access to the wallet dir could then unlock it.

---

### Step 5.2 — Wallet Owner API ECDH session

**New files**: `app/lib/wallet/owner-api.js`

ECDH session flow (per Grin Owner API v3 spec):
```
1. init_secure_api → server returns its ECDH public key
2. Generate client ECDH keypair
3. Derive shared AES-256-GCM key
4. open_wallet({ name, password }) — first encrypted call
5. All subsequent calls: encrypt request, decrypt response
```

A working reference implementation of this flow exists in the prior
Windows toolkit repo (`d:\Git_noob\GrinSuite\web\03_web_wallet\server.js`,
lines ~32-180). **Port verbatim** with no logic changes — just refactor
into a module. Keep that file readable as a sanity check while porting.

---

### Step 5.3 — Wallet Foreign API proxy

Public-facing endpoint so other wallets can send to this one.

```
POST /api/wallets/:name/foreign/receive_tx  ← proxies to wallet's :3415/:13415
```

Only needed when wallet listener is running.

---

### Step 5.4 — Wallet listener lifecycle

```
POST /api/wallets/:name/listener/start
  → spawn(grin-wallet, ['listen','--method','http',...])
  → store ChildProcess in sessions map
  → emit 'listener-started' on SSE
POST /api/wallets/:name/listener/stop
  → SIGTERM the listener proc
```

---

### Step 5.5 — Send / receive UI flows

UI calls Owner API methods via the ECDH session:
- `init_send_tx`, `tx_lock_outputs`, `finalize_tx`
- Slatepack flow for offline send/receive
- (Phase 6) Tor address direct send

---

### Step 5.6 — Balance + history

`retrieve_summary_info`, `retrieve_txs` calls, displayed in dashboard.

---

### Phase 5 Done When

- Create wallet → seed words shown once, user confirms by re-entering 3
  words at random positions
- Receive: paste a slatepack S1 → wallet returns S2
- Send: paste a slatepack S2 → wallet returns S3 → finalize → balance
  decrements after next block
- Tested end-to-end on testnet (no real GRIN risked)

---

## Phase 6 — Tor

Goal: enable private send/receive via .onion addresses.

### Step 6.1 — Tor service

Already installed in Phase 2. Service registration mirrors NSSM flow.
Tor has native SCM support — no NSSM needed. Register via `sc.create`.

### Step 6.2 — Onion address provisioning

```
For each wallet that opts in:
  Generate HiddenServiceDir under data/wallets/<name>/tor/
  Add to torrc:
    HiddenServiceDir <path>
    HiddenServicePort 80 127.0.0.1:<wallet_foreign_port>
  Restart tor → hostname file appears → read .onion address
  Store in wallets.json
```

### Step 6.3 — Tor-routed sends

Owner API supports `address: 'http://<onion>.onion'` natively when SOCKS5
proxy is configured. Pass `--socks5_proxy_addr 127.0.0.1:9050` to
grin-wallet at listener start.

---

### Phase 6 Done When

- Wallet shows its own .onion address in the UI
- Send to another tester's .onion → arrives → transaction visible in
  history after a block

---

## Phase 7 — Setup Wizard (UI)

Goal: a non-technical user, on first launch, sees a clean step-by-step
wizard that builds the wallet without ever opening a config file.

### Step 7.1 — Wizard state machine

```
Steps:
  1. Welcome  — show what this is, click "Get started"
  2. Network  — Mainnet / Testnet radio
  3. Binaries — auto-install with progress (Phase 2)
  4. Node     — auto-install + start service (Phase 3) + chain_data (Phase 4)
  5. Wallet   — Create new / Recover from seed
  6. Tor      — Enable? (default yes) — provision .onion
  7. Done     — redirect to /dashboard
```

State persists in `state/app.json`: `firstRunComplete = false` until step 7.

---

### Step 7.2-7.6 — Each step as a route

`/setup/welcome`, `/setup/network`, `/setup/binaries`, etc. Each is its
own HTML page (no SPA — simpler, faster). Server-side guards: if
`firstRunComplete`, redirect to `/dashboard`.

---

### Phase 7 Done When

- New user `irm | iex` install → sees wizard, never sees a config file
- Wizard can be re-entered from Settings if they want to add another
  wallet or another network

---

## Phase 8 — Dashboard

Goal: post-setup, the user lands here for daily use.

### Layout (single page, sections):
- **Wallet selector** (if multiple) + balance prominent
- **Send / Receive** big buttons
- **Transaction history** (paginated)
- **Node status** (sync %, peers, height) — collapsible
- **Settings** link (sidebar)

### Step 8.1 — Layout shell

Plain HTML + a small JS module per panel. No framework (keeps "readable
by curious users" intact per the README).

### Step 8.2 — Node panel

Polls `/api/node/:network/status` every 3s.

### Step 8.3 — Wallet panel

Polls `/api/wallets/:name/summary` after every action.

### Step 8.4 — Settings

- Change network default
- Add another wallet
- Backup wallet (zip of data/wallets/<name>/)
- Restore wallet
- Service auto-start mode (auto / demand / manual)
- Self-update (Phase 9)

---

### Phase 8 Done When

- User can perform every daily action without touching the wizard or any
  PS / config file

---

## Phase 9 — Self-Update

### Step 9.1 — Git pull flow (preferred)

```
POST /api/update
  ├─ Detect git on PATH
  ├─ git -C <installDir> fetch
  ├─ Compare HEAD vs origin/main — show diff summary in UI
  ├─ git pull --ff-only
  ├─ cd app && npm install --omit=dev
  ├─ Schedule restart: spawn detached process to relaunch in 2s
  └─ exit(0)
```

### Step 9.2 — ZIP fallback (no git)

```
If git missing:
  ├─ Download latest release ZIP from GitHub
  ├─ Extract to temp dir
  ├─ Robocopy /MIR over installDir (except state/, data/, logs/)
  └─ Restart as above
```

### Step 9.3 — Restart handler

Browser shows "updating…" then polls `/api/health`. When it comes back
online with a new version string, redirect to `/` with a success banner.

---

### Phase 9 Done When

- User clicks "Check for updates" → sees diff summary → confirms → app
  updates in place → browser auto-reloads with new version

---

## Cross-Cutting

### Error handling
- Every endpoint wraps logic in `try/catch` → returns `{error: msg, code}`
- UI shows toast for errors, logs to console
- Long operations (downloads) emit `error` events on SSE so the UI can
  abort gracefully

### State recovery
- If `binaries.json` says `grin.exe` installed but file is missing → mark
  as not installed, re-run installer next time user touches that flow
- If `chain_data` is partial (`.part` file present) → resume on next start
- If a service exists in SCM but not in `nodes.json` (manual user action)
  → adopt it into `nodes.json` on next status poll

### Antivirus / SmartScreen
- Test on a clean Win11 25H2 VM with Defender on default
- If `irm | iex` is flagged: submit `install.ps1` to Microsoft for review
- If `grin.exe` is flagged: surface a clear UI message linking to the
  Defender exclusion docs

### Logging
- Every long operation has a `scope` so UI can filter
- Errors include stack trace in file log but only `msg` on SSE

---

## Phase Dependency Graph

```
Phase 0 (skeleton)  ──► Phase 1 (plumbing)
                            │
                            ▼
                       Phase 2 (binaries) ──► Phase 3 (services)
                            │                       │
                            ▼                       ▼
                       (none direct)           Phase 4 (node)
                                                    │
                                                    ▼
                                               Phase 5 (wallet)
                                                    │
                                                    ▼
                                               Phase 6 (tor) — needs wallet
                                                    │
                                                    ▼
                                               Phase 7 (wizard)   ◄── ties them together
                                                    │
                                                    ▼
                                               Phase 8 (dashboard)
                                                    │
                                                    ▼
                                               Phase 9 (updates)
```

You can run phases 7 + 8 in parallel with 4-6 if a second person joins —
mock data fills the gaps until the real APIs land.

---

## Open Questions Before Start

All six decisions resolved on 2026-05-26 — recorded in
[architecture.md §12](architecture.md#12-decisions-made-2026-05-26):

1. **Install dir**: `D:\Grin\` preferred, `C:\Grin\` fallback, 20 GiB minimum free
2. **Networks**: mainnet + testnet run side by side by default
3. **Wallets per network**: multiple, registry-backed
4. **Service start type**: user choice (demand or auto), prompted in wizard
5. **Tor**: default on
6. **License**: Apache 2.0

---

## What to Build First (Recommendation)

Once the questions above have answers, the order is:

1. **Phase 1 in one sitting** (~1 day) — establishes the foundation,
   debug endpoint proves it
2. **Phase 2** (~2-3 days) — first time the user has *something to install*
3. **Phase 3** (~1-2 days) — services running, browser can start/stop
4. **Phase 4** (~3-5 days) — the long one because of chain_data UX
5. **Phase 5** (~5-7 days) — wallet logic is the trickiest
6. **Phase 6** (~1-2 days) — Tor mostly just config
7. **Phase 7-8** (~3-5 days) — UI polish
8. **Phase 9** (~1 day)

~20-30 days of focused work to MVP. Realistic calendar time depending on
how much testing each phase gets on real hardware.
