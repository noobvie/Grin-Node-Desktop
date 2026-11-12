# Module layout — the contract every module is built to

Sibling docs: [architecture.md](architecture.md) (why), [coding-plan.md](coding-plan.md)
(what, in what order), [function-flows.md](function-flows.md) (per-function pseudocode).
This file is the **file-structure contract**: where code lives, how big a file may be,
and the interfaces modules expose to each other. Change it before changing the tree.

## 1. Rules

- **Node.js CommonJS**, `'use strict'`, no transpiler, no framework beyond Express.
- **One concern per file, ≤ 350 lines.** A file that needs more is split by concern
  (e.g. `chaindata-mirrors.js` + `chaindata.js`), never by "part 1 / part 2".
- **`server.js` is boot only**: middleware, router mounts, `listen`. No business logic.
- **Routers live in `lib/api/`**, one file per URL area, each `module.exports = router`.
  Routers validate input and call a `lib/<area>/` module; they hold no logic of their own.
- **Every external process goes through `lib/util/exec.js`** (`execFile`, never a shell
  string). Tests replace the runner with `exec.setRunnerForTests(fn)`; production code
  never calls `child_process` directly. PowerShell goes through `lib/util/ps.js`.
- **Every path comes from `lib/util/paths.js`.** No module builds `D:\Grin\...` itself.
- **No new npm dependency** without a line in §5 saying why. Current set: `express`,
  `tar`, `yauzl`, `@iarna/toml`. `package-lock.json` is committed; bootstrap runs `npm ci`.
- **Comments state what is true now and why.** No "was X, now Y", no phase tags, no
  commented-out code.
- **Nothing in `lib/` writes outside `INSTALL_ROOT`**, and `rm -rf`-class operations
  (`fs.rmSync(..., {recursive:true})`) are only ever applied to a path that
  `paths.assertInsideData(p)` has accepted.
- **Tests**: `cd app && npm test` → `node --test "test/*.test.js"` (built-in `node:test`, no
  framework; a trailing-slash directory argument makes Node 24 report 0 tests). A test
  never downloads from the internet, never registers a Windows service, never binds
  anything but `127.0.0.1`, and kills every process it starts.

## 2. Tree

```
app/
  server.js                      boot: guards → static → routers → listen        (≤120)
  package.json  package-lock.json
  lib/
    util/
      paths.js                   INSTALL_ROOT + every well-known path; assertInside / assertInsideData
      sysbin.js                  absolute System32 paths of sc, taskkill, cmd, icacls, powershell
      elevation.js               isElevated() → cached Promise<boolean> (asked once, via ps.js)
      log.js                     console + daily file + SSE 'log'
      sse.js                     Server-Sent Events broadcaster
      state.js                   atomic JSON state files (app/binaries/nodes/wallets)
      download.js                https download, resume, SHA256, backpressure, progress
      extract.js                 zip / tar.gz with zip-slip guards and an entry allow-list (filter)
      exec.js                    run(file, args, opts) → {code, stdout, stderr}; test hook
      ps.js                      psJson(script) → parsed object via powershell.exe
      disk.js                    freeBytes(path), requireFree(path, bytes)
      net.js                     tcpListening(port) → {pid, exe} | null  (via ps.js)
    security/
      origin-guard.js            Host allow-list, Origin/Sec-Fetch-Site on mutations
      session-token.js           per-process token; GET /api/session/token; header check
      headers.js                 CSP, X-Frame-Options, nosniff, Referrer-Policy on every reply
    installer/
      github.js                  latestRelease(owner, repo, assetRegex) + sha256sum asset
      binaries.js                installGrin/installGrinWallet/installTor/installNssm → bin/
      binaries-manifest.js       pinned URLs + SHA256 for tor and nssm (data only)
      toml.js                    readToml / writeToml / patchToml (dotted keys)
      node-config.js             grin-server.toml per network+mode, .api_secret files
      chaindata-mirrors.js       mirror list / manifest discovery (data + fetch only)
      chaindata.js               downloadChainData({network, mode}) → verify → extract
    services/
      catalog.js                 service names, exe, args, cwd, ports per network/mode
      sc.js                      query/start/stop/setStartType/remove via sc.exe
      nssm.js                    install/get/set/remove via bin/nssm.exe
      process-scan.js            grinProcesses() → [{pid, exe, cmdline, network}]
    node/
      owner-api.js               ownerCall(network, method, params) → unwrapped Ok
      scan.js                    scanNodes() → NodeTable (the one scan every screen uses)
      registry.js                nodes.json read/update helpers
      liveness.js                nodeIsUp (process OR service not stopped), waitForNoProcess (quiet = both)
      jobs.js                    background jobs: one per key, blockedBy, SSE 'job'; owns phases 'done'/'failed'
      ops-lifecycle.js           startNode / stopNode / stopAndConfirm (service first, orphan sweep)
      ops-install.js             installNode({network, mode}) orchestration
      ops-update.js              updateBinary(networks): stop → stage grin.exe.new → rename swap (keep grin.prev) → start-if-was-up; rollback
      ops-rebuild.js             rebuildChainData(network) / fullReinstall(network)
    api/
      session.js                 GET /api/session/token
      health.js                  GET /api/health → { ok, version, installRoot, elevated }
      setup.js                   POST /api/setup/install-binaries, /configure-node
      node.js                    GET /api/node, /api/node/:network/status; POST start|stop|update|rebuild|install
      services.js                GET /api/services, POST install|start|stop|start-type
  public/
    index.html                   shell + nav; no inline script
    css/app.css
    js/api.js                    fetch wrapper: adds X-Grin-Session, unwraps {error}
    js/sse.js                    EventSource → named handlers
    js/elevation.js              shows the "not Administrator" banner from /api/health
    js/node-panel.js             node table + actions (Script 01 parity screen)
    js/progress.js               download/extract progress bars
  test/
    *.test.js                    one file per lib module; fixtures under test/fixtures/
    helpers/tmp-root.js          sets GRIN_INSTALL_ROOT to a temp dir; called before the first lib require
```

`bin/`, `data/`, `state/`, `logs/`, `.tmp/` are runtime dirs under `INSTALL_ROOT`
(architecture.md §4) and are git-ignored.

## 3. Node binary placement (decision 2026-11-09)

`bin/grin.exe` is the **store copy** (what the installer downloaded, like
`/opt/grin/bin` on the Linux toolkit). Each node runs **its own copy**:
`data/node-<network>/grin.exe`. Consequences, all deliberate:

- "running" is decided by **process executable path == `<nodeDir>\grin.exe`**, never by
  "port 3414 is open" (GrinSuite's recurring false-positive bug) and never by parsing
  `--testnet` out of a command line.
- Update and rollback are **per network**: the old copy becomes `<nodeDir>\grin.prev`.
- A foreign process holding 3414/13414 is a red status line, not a node.

## 4. Interfaces (signatures other modules rely on)

```js
// util/exec.js
run(file, args, { cwd, timeoutMs = 60_000, input, env } = {}) → Promise<{ code, stdout, stderr }>
setRunnerForTests(fn | null)

// util/ps.js
psJson(script, { timeoutMs } = {}) → Promise<any>     // UTF-8 stdout prefix + "| ConvertTo-Json -Compress -Depth 4"

// util/paths.js
assertInside(root, p) → resolved path                   // throws unless strictly below root (case-insensitive on win32)
assertInsideData(p)                                     // assertInside(DATA_DIR, p)
torDataDir() → DATA_DIR\tor                             // torrc + Tor data, outside bin\tor

// util/extract.js
extract({ archive, dest, format, label, filter }) → Promise<{ files, bytes }>
  // filter(entryPath, entryType) → boolean; the first rejected entry FAILS the extraction

// util/elevation.js
isElevated() → Promise<boolean>                         // computed once per process

// util/disk.js
freeBytes(dir) → Promise<number>                        // fs.statfs
requireFree(dir, bytes, label) → Promise<void>          // throws Error with GiB figures

// util/net.js
tcpListener(port) → Promise<{ pid, exe } | null>

// security/origin-guard.js
originGuard({ port }) → express middleware             // 403 on bad Host; 403 on bad Origin for non-GET
// security/session-token.js
token()                                                  // string, generated once per process
requireToken() → express middleware                      // header X-Grin-Session must equal token()
// security/headers.js
securityHeaders() → express middleware                   // mounted right after originGuard, before the body parser
router                                                   // GET /api/session/token (same-origin fetch only)

// installer/github.js
latestRelease(owner, repo, assetRegex) → Promise<{ tag, version, asset: { name, url, size }, sha256: string | null }>

// installer/binaries.js
installGrin({ force } = {}) → Promise<{ version, path, sha256 }>
installGrinWallet(...) installTor(...) installNssm(...) → same shape
installAll({ force } = {}) → Promise<Record<name, result>>

// installer/toml.js
readToml(file) → object ; writeToml(file, obj) ; patchToml(file, { 'server.api_http_addr': '127.0.0.1:3413', ... })

// installer/node-config.js
generateNodeConfig({ network, mode }) → Promise<{ dir, toml }>   // writes toml + secrets if missing

// installer/chaindata.js
downloadChainData({ network, mode, onProgress }) → Promise<{ bytes, sha256, dir }>

// services/catalog.js
NETWORKS = ['mainnet', 'testnet'] ; MODES = ['pruned', 'full']
ports(network) → { p2p, api, stratum }
serviceName({ network, mode }) → 'GrinNode-Mainnet-Pruned'
nodeServiceSpec({ network, mode }) → { name, exe, args, cwd, stdout, stderr }
// services/sc.js
query(name) → Promise<{ exists, state, startType } >   // state: 'running'|'stopped'|'start_pending'|'stop_pending'|…
start(name) stop(name, { timeoutMs }) setStartType(name, 'auto'|'demand'|'disabled') remove(name)
// services/nssm.js
install(name, exe, args) ; get(name, param) ; set(name, param, value) ; remove(name)
// services/process-scan.js
grinProcesses() → Promise<[{ pid, exe, cmdline }]>

// node/scan.js
scanNodes() → Promise<{ mainnet: NodeRow, testnet: NodeRow }>
NodeRow = { network, dir, mode, installed, binaryVersion, hasPrev, running, pid, service: { exists, state, startType } | null,
            staleServices: [], autostart: 'on'|'other-dir'|'off', foreignHolder: { pid, exe } | null, extraDirs: [],
            status: {…owner get_status or null}, allowed: { start, stop, update, rollback, rebuild, install }, warnings: [] }
// node/owner-api.js
ownerCall(network, method, params = []) → Promise<any>  // unwraps {Ok}; throws on {Err}; 3 s timeout
getStatus(network) → Promise<{ height, syncStatus, syncInfo, connections, version } | null>
// node/ops-*.js
startNode(network) stopNode(network) → Promise<{ ok, result, detail, refused? }>   // refused: a "not now" answer (HTTP 409)
stopAndConfirm(network) → Promise<{ ok, wasRunning, detail }>                     // stop when nodeIsUp, then require quiet
nodeIsUp(network) → Promise<boolean>                                              // a process of the dir OR a service not 'stopped'
waitForNoProcess(network) → Promise<{ quiet, processes, services }>
installNode({ network, mode, startType, chainData }) → Promise<NodeRow>            // error.status 409 when already installed
assertInstallable({ network, chainData })                                          // the same refusal, for the route
updateBinary(networks) → Promise<[{ network, from, to, wasRunning, restarted, rolledBack, error }]>
rollbackBinary(network) → Promise<{ …same shape }>
rebuildChainData(network) fullReinstall(network, { mode, chainData }) → Promise<NodeRow>
// node/jobs.js
start({ key, network, op, run, blockedBy: [{ key, ops? }] }) → job view ; throws error.status 409 when busy or blocked
```

## 5. Dependencies and why

| Package | Why |
|---|---|
| `express` | HTTP + static. |
| `tar` | tar.gz extraction with `strict` entry checks (chain data, Tor bundle). |
| `yauzl` | zip extraction without writing to disk first (grin, nssm). |
| `@iarna/toml` | round-trip `grin-server.toml` editing; regex editing of TOML is how GrinSuite broke. |

## 6. Windows traps that apply to this codebase

- `wmic` is removed on Windows 11 24H2+: process lookups use `Get-CimInstance Win32_Process`
  through `ps.js`, never `wmic`.
- `sc stop` returns before the service is stopped: `sc.stop` polls `query` until `stopped`
  or the timeout, then reports which.
- A file written with a UTF-8 BOM breaks grin's secret files: all writes use
  `fs.writeFileSync(p, s, 'utf8')` (Node never writes a BOM).
- A running `grin.exe` can be **renamed** on NTFS (`fs.renameSync` succeeds); only
  overwriting it (`EBUSY`) or deleting it (`EPERM`) fails. So moving `grin.exe` to
  `grin.prev` under a live node raises no error and the node keeps running the old binary
  from its new name: `ops-update` stops the node and confirms the process is gone before
  swapping — the file system will not catch that mistake.
- Bare tool names (`sc.exe`, `taskkill`) resolve through the current directory and `PATH`:
  every system tool is spawned by its absolute System32 path from `util/sysbin.js`.
- `sc.exe` translates its labels and messages (`STATE` is `STATUS` on a German Windows):
  `sc.js` reads only numeric codes, state constants and Win32 error numbers.
- PowerShell `ConvertTo-Json` returns a bare object for one result and an array for many:
  `ps.js` callers wrap with `[].concat(x ?? [])`.
