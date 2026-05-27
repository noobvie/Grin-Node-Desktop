# Function Flows — Detailed Logic per Function

Companion to [coding-plan.md](coding-plan.md). The plan tells you **what
to build and in what order**; this doc tells you **what each function
actually does, line by line**.

**Depth strategy:**
- **Phases 1-3** (foundation, binaries, services) — fully detailed.
  These are next-up work; vague pseudocode here = real bugs in code.
- **Phases 4-9** — function sketches with enough flow to confirm
  approach. Will be deepened as each phase begins (decisions made now
  may not survive contact with the earlier phases).

**Format per function:**
- **Purpose** — one line
- **Signature** — inputs / returns
- **Side effects** — what it touches outside its arguments
- **Errors** — failure modes worth catching
- **Flow** — pseudocode, not real JS
- **Used by** — where it's called from

---

# Phase 1 — Foundation Plumbing

## app/lib/util/sse.js

### `subscribe(req, res) → void`

**Purpose:** attach a browser EventSource to the broadcast list.

**Side effects:** mutates module-level `clients[]`; sends headers + initial
keep-alive on `res`.

**Errors:** none — client disconnect is normal, handled by `'close'` event.

**Flow:**
```
1. Set headers on res:
     Content-Type: text/event-stream
     Cache-Control: no-cache
     Connection: keep-alive
     X-Accel-Buffering: no    ← guards against nginx proxy buffering later
2. Write initial ":\n\n" (SSE comment) so client knows connection is live.
3. Push res into clients[].
4. Start a per-client keep-alive interval (25s) that writes ":\n\n".
5. On req 'close':
     clearInterval(keepAlive)
     remove res from clients[]
```

**Used by:** `GET /api/events` endpoint in `server.js`.

---

### `emit(event, data) → void`

**Purpose:** broadcast a structured event to every connected client.

**Side effects:** writes to every res in `clients[]`; silently drops
clients whose write fails (already disconnected).

**Flow:**
```
1. payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
2. For each res in clients[]:
     try res.write(payload)
     catch  → mark for removal (write after close)
3. After loop, filter clients[] to remove marked ones.
```

**Event types used elsewhere:**
- `log` — every log line (Step 1.2)
- `download-progress` — `{label, bytes, total, pct}` (Step 1.4)
- `binary-installed` — `{name, version}` (Phase 2)
- `node-status` — periodic node sync state (Phase 4)
- `error` — `{scope, msg}` for fatal errors UI must surface

**Used by:** `log.js`, every installer, every long-running endpoint.

---

### `count() → number`

**Purpose:** how many subscribers right now. Used by `log.js` to decide
whether to format SSE payload (skip if nobody's listening).

**Flow:** `return clients.length`

---

## app/lib/util/log.js

### `log(level, scope, msg, meta?) → void`

**Purpose:** one call → console + file + SSE.

**Signature:**
- `level: 'debug' | 'info' | 'warn' | 'error'`
- `scope: string` (e.g. `'installer.grin'`, `'wallet.ecdh'`)
- `msg: string`
- `meta?: object` (extra structured data, lazy-stringified)

**Side effects:**
- Writes to stdout
- Appends to `<logsDir>/app-<YYYY-MM-DD>.log`
- Emits SSE `log` event if any subscribers
- Rotates old logs (keeps 14 newest)

**Errors:** swallowed (logging must never throw — would cascade).

**Flow:**
```
1. ts   = new Date().toISOString()
2. tsHuman = HH:MM:SS portion for console
3. line = `[${tsHuman}] [${level.toUpperCase()}] [${scope}] ${msg}`
4. console.log(line)                          ← always

5. ensureLogsDirExists() once per process     ← memoised
6. logFile = path.join(logsDir, `app-${ts.slice(0,10)}.log`)
7. fs.appendFileSync(logFile, line + (meta? ' ' + JSON.stringify(meta) : '') + '\n')
   ← sync write keeps order; volume is low (a few hundred lines/min worst case)

8. if (sse.count() > 0):
     sse.emit('log', { ts, level, scope, msg, meta })

9. Rotation (lazy, once per day):
     if (today !== lastRotationCheckDate):
         list logsDir, find app-*.log
         keep newest 14, unlink rest
         lastRotationCheckDate = today
```

**Convenience wrappers:**
- `info(scope, msg, meta)`  → `log('info', scope, msg, meta)`
- `warn`, `error`, `debug`  — same shape

**Used by:** every module. Replaces `console.log` everywhere except
`server.js` startup banner (chicken/egg: log dir might not exist yet).

---

## app/lib/util/paths.js

### Constants (computed once on module load)

```
INSTALL_ROOT = path.join(os.homedir(), 'Grin-Money-Desktop')
BIN_DIR      = path.join(INSTALL_ROOT, 'bin')
DATA_DIR     = path.join(INSTALL_ROOT, 'data')
STATE_DIR    = path.join(INSTALL_ROOT, 'state')
LOGS_DIR     = path.join(INSTALL_ROOT, 'logs')
TEMP_DIR     = path.join(INSTALL_ROOT, '.tmp')

nodeDataDir(network)     = path.join(DATA_DIR, `node-${network}`)
walletDataDir(name)      = path.join(DATA_DIR, 'wallets', name)
binaryPath(name)         = path.join(BIN_DIR, `${name}.exe`)
stateFile(name)          = path.join(STATE_DIR, `${name}.json`)
```

### `ensureLayout() → void`

**Purpose:** call once on server startup. Creates the entire dir tree if
missing. Idempotent.

**Flow:**
```
for dir in [INSTALL_ROOT, BIN_DIR, DATA_DIR, STATE_DIR, LOGS_DIR, TEMP_DIR]:
    fs.mkdirSync(dir, { recursive: true })
```

**Used by:** `server.js` before any other module touches disk.

---

## app/lib/util/state.js

### `readState(name) → object`

**Purpose:** load a JSON state file, return parsed object (or default if
absent or malformed).

**Signature:** `name: 'app' | 'binaries' | 'nodes' | 'wallets'`

**Side effects:** reads file. Caches result in memory.

**Errors:**
- File missing → return default schema (defined per name)
- JSON parse error → log warn, back up corrupt file to `<name>.corrupt-<ts>.json`,
  return default schema

**Flow:**
```
1. file = paths.stateFile(name)
2. if cache[name] && mtime unchanged → return cache[name]
3. if !fs.existsSync(file) → return defaultSchema[name]
4. raw = fs.readFileSync(file, 'utf8')
5. try parsed = JSON.parse(raw)
   catch:
     log.warn('state', `corrupt ${file}, backing up`)
     fs.renameSync(file, file + `.corrupt-${Date.now()}.json`)
     return defaultSchema[name]
6. cache[name] = { data: parsed, mtime: fs.statSync(file).mtimeMs }
7. return parsed
```

**Default schemas:**
```
app      = { version: '0.0.1', firstRunComplete: false, network: null }
binaries = { grin: null, grinWallet: null, tor: null, nssm: null }
nodes    = { nodes: [] }
wallets  = { wallets: [] }
```

---

### `writeState(name, data) → void`

**Purpose:** atomically replace a state file. Never corrupts on crash.

**Side effects:** writes file, invalidates cache.

**Flow:**
```
1. file = paths.stateFile(name)
2. tmp  = file + '.tmp'
3. json = JSON.stringify(data, null, 2)
4. fs.writeFileSync(tmp, json, 'utf8')        ← always utf8, never BOM
5. fs.renameSync(tmp, file)                   ← atomic on NTFS
6. cache[name] = { data, mtime: fs.statSync(file).mtimeMs }
```

**Crash behaviour:** if killed between 4 and 5, original file untouched.
If killed between 5 and 6, cache stale but `readState` mtime check
detects it.

---

### `updateState(name, mutator) → object`

**Purpose:** read-modify-write helper. Returns the new state.

**Flow:**
```
current = readState(name)
next    = mutator(structuredClone(current))    ← mutator may mutate copy
writeState(name, next)
return next
```

**Example use:**
```js
updateState('binaries', s => { s.grin = { version, path, sha256 }; });
```

---

## app/lib/util/download.js

### `download({ url, dest, sha256?, label?, headers? }) → Promise<{bytes, sha256}>`

**Purpose:** stream a remote file to disk with SHA verify, progress
events, retry on transient failure, optional range resume.

**Inputs:**
- `url` — http or https
- `dest` — final path on disk
- `sha256` — optional expected hex hash; if provided, verified after download
- `label` — human-readable name for progress events (e.g. `'grin v5.4.0'`)
- `headers` — optional extra request headers (e.g. for GitHub auth)

**Returns:** `{ bytes, sha256 }` (sha256 always computed, even if not verified).

**Side effects:** creates `dest`, writes `dest + '.part'` during download,
emits SSE progress events.

**Errors:**
- Network failure after 3 retries → throws
- SHA mismatch → throws, deletes `.part`

**Flow:**
```
const MAX_RETRIES = 3
const RETRY_BACKOFF_MS = 3000
const partFile = dest + '.part'

for attempt in 1..MAX_RETRIES:
  try:
    // ── Resume support ──────────────────────────────────────────────
    startByte = 0
    if fs.existsSync(partFile):
        startByte = fs.statSync(partFile).size
        log.info('download', `resuming ${label} at ${startByte} bytes`)
    
    // ── HEAD to get total size ──────────────────────────────────────
    headInfo = await headRequest(url, headers)
    total    = headInfo.contentLength            // may be undefined
    
    // ── Open file in append mode if resuming, write mode if not ─────
    flags = startByte > 0 ? 'a' : 'w'
    out   = fs.createWriteStream(partFile, { flags })
    
    // ── Stream request ──────────────────────────────────────────────
    reqHeaders = { ...headers }
    if startByte > 0:
        reqHeaders['Range'] = `bytes=${startByte}-`
    
    response = await httpsGet(url, reqHeaders)
    
    if startByte > 0 and response.statusCode === 200:
        // Server doesn't support Range — start over
        log.warn('download', `server ignored Range, restarting ${label}`)
        out.end()
        fs.unlinkSync(partFile)
        startByte = 0
        out = fs.createWriteStream(partFile, { flags: 'w' })
        // (loop will retry; continue would skip retries)
        continue
    
    if response.statusCode not in [200, 206]:
        throw new Error(`HTTP ${response.statusCode}`)
    
    // ── Hash as we stream ───────────────────────────────────────────
    hash  = crypto.createHash('sha256')
    bytes = startByte
    
    response.on 'data' chunk:
        out.write(chunk)
        hash.update(chunk)
        bytes += chunk.length
        if bytes - lastEmitBytes > 64KB:
            sse.emit('download-progress', {label, bytes, total, pct: bytes/total*100})
            lastEmitBytes = bytes
    
    response.on 'end':
        out.end()
        await once(out, 'finish')
        actualSha = hash.digest('hex')
        
        if sha256 and sha256.toLowerCase() !== actualSha.toLowerCase():
            fs.unlinkSync(partFile)
            throw new Error(`SHA256 mismatch: expected ${sha256}, got ${actualSha}`)
        
        fs.renameSync(partFile, dest)
        sse.emit('download-progress', {label, bytes, total, pct: 100, done: true})
        log.info('download', `${label} ok (${bytes} bytes, sha ${actualSha.slice(0,12)}…)`)
        return { bytes, sha256: actualSha }
    
    response.on 'error' err: throw err
  
  catch err:
    log.warn('download', `attempt ${attempt} failed: ${err.message}`)
    if attempt === MAX_RETRIES: throw err
    await sleep(RETRY_BACKOFF_MS)
```

**Important details:**
- The `.part` file persists across crashes → resume works on next call
- Hash is computed from byte 0 (so we re-hash old bytes on resume — required
  because we can't trust the server's data without re-hashing the whole file).
  For multi-GB chain_data, this means a resumed download still re-reads the
  partial file. **Open optimisation:** persist intermediate hash state. Defer
  unless chain_data resume turns out to be slow in practice.

**Used by:** every installer step (Phase 2), chain_data download (Phase 4),
self-update ZIP download (Phase 9).

---

## app/lib/util/extract.js

### `extract({ archive, dest, format? }) → Promise<void>`

**Purpose:** unpack `.zip` or `.tar.gz` into a directory.

**Inputs:**
- `archive` — path to archive file
- `dest` — directory (created if absent)
- `format` — `'zip' | 'tar.gz'`, inferred from extension if omitted

**Side effects:** writes files under `dest`, emits SSE `extract-progress`.

**Flow:**
```
format = format || inferFromExt(archive)
fs.mkdirSync(dest, { recursive: true })

if format === 'zip':
    extractZip(archive, dest)
else if format === 'tar.gz':
    extractTarGz(archive, dest)
else:
    throw `unknown format ${format}`

inferFromExt(archive):
    if archive.endsWith('.zip')    → 'zip'
    if archive.endsWith('.tar.gz') → 'tar.gz'
    if archive.endsWith('.tgz')    → 'tar.gz'
    throw
```

### `extractZip(archive, dest) → Promise<void>`

Use `yauzl` (streaming zip reader, doesn't load entire archive into memory).

```
await yauzl.open(archive):
  zipFile.on 'entry' entry:
      target = path.join(dest, entry.fileName)
      sanitizePath(target, dest)            ← prevent zip-slip
      if entry.fileName endsWith '/':
          fs.mkdirSync(target, recursive)
          zipFile.readEntry()
      else:
          mkdir of dirname
          openReadStream(entry) → pipe to fs.createWriteStream(target)
          on stream end: zipFile.readEntry()
  zipFile.on 'end': resolve()
```

**Zip-slip guard:** `sanitizePath(target, base)` throws if
`path.resolve(target)` doesn't start with `path.resolve(base) + sep`.

### `extractTarGz(archive, dest) → Promise<void>`

Use `tar` npm package which handles gunzip + untar in one stream.

```
await fs.createReadStream(archive)
    .pipe(tar.x({ cwd: dest, strict: true }))
```

`strict: true` makes tar refuse unsafe paths (built-in zip-slip equivalent).

**Used by:** binary installers (Phase 2), chain_data extraction (Phase 4).

---

## Phase 1 Verification Endpoint

`server.js` adds a temporary debug endpoint that exercises the whole
plumbing stack:

```
GET /api/dev/test-plumbing
  ├─ log.info('dev', 'starting plumbing test')
  ├─ download({
  │     url: 'https://nssm.cc/release/nssm-2.24.zip',
  │     dest: paths.TEMP_DIR + '/nssm-test.zip',
  │     sha256: 'be7b3577…',     ← known good
  │     label: 'NSSM (test)'
  │   })
  ├─ extract({ archive: …, dest: paths.TEMP_DIR + '/nssm-test/' })
  ├─ updateState('app', s => { s.lastPlumbingTest = new Date().toISOString() })
  └─ return { ok: true, sha256, extracted: listDir(…) }
```

If this endpoint returns `ok: true` with the expected SHA and the
`win64/nssm.exe` is on disk and runs (`--version`), Phase 1 is done.

Remove this endpoint before Phase 7.

---

# Phase 2 — Binary Installer

## app/lib/installer/github.js

### `latestRelease(owner, repo, assetPattern) → Promise<{tag, asset}>`

**Purpose:** find the newest release of a repo and the matching asset.

**Signature:**
- `owner` — e.g. `'mimblewimble'`
- `repo` — e.g. `'grin'`
- `assetPattern` — `RegExp` matched against `asset.name`

**Returns:** `{ tag: string, asset: { name, url, size, contentType } }`

**Errors:**
- 404 → throws `'no releases for owner/repo'`
- Rate-limit (403 with `x-ratelimit-remaining: 0`) → throws with reset time
- No asset matches → throws `'no asset matches /pattern/ in tag XYZ'`

**Flow:**
```
url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'grin-money-desktop',
    'X-GitHub-Api-Version': '2022-11-28'
}
res = await httpsGetJson(url, headers)
if !res.tag_name: throw 'no releases'
assets = res.assets.filter(a => assetPattern.test(a.name))
if assets.length === 0: throw `no asset matches ${assetPattern} in ${res.tag_name}`
asset = assets[0]
return {
    tag:   res.tag_name,
    asset: { name: asset.name, url: asset.browser_download_url, size: asset.size, contentType: asset.content_type }
}
```

**Caching:** result cached in memory for 1 hour per (owner, repo, pattern)
to avoid hitting GitHub rate limits during repeated installs in dev.

**Used by:** `installGrin`, `installGrinWallet`.

---

## app/lib/installer/binaries.js

### `installGrin() → Promise<{version, path}>`

**Purpose:** download + place `grin.exe`.

**Flow:**
```
log.info('installer.grin', 'starting')
release = await github.latestRelease('mimblewimble', 'grin', /grin-v.*-win-x64\.zip$/)
log.info('installer.grin', `latest: ${release.tag}`)

state = readState('binaries')
if state.grin && state.grin.version === release.tag && fs.existsSync(state.grin.path):
    log.info('installer.grin', 'already installed at this version, skipping')
    return state.grin

tempZip = path.join(paths.TEMP_DIR, release.asset.name)
{ sha256 } = await download({
    url:   release.asset.url,
    dest:  tempZip,
    label: `grin ${release.tag}`
})

tempExtract = path.join(paths.TEMP_DIR, 'grin-extract')
await fs.promises.rm(tempExtract, { recursive: true, force: true })
await extract({ archive: tempZip, dest: tempExtract })

// Zip layout: grin-v5.4.0-win-x64/grin.exe (versioned subfolder)
inner = findFile(tempExtract, 'grin.exe')
if !inner: throw 'grin.exe not found in archive'

dest = paths.binaryPath('grin')
await fs.promises.copyFile(inner, dest)
await fs.promises.rm(tempExtract, { recursive: true })
await fs.promises.unlink(tempZip)

result = { version: release.tag, path: dest, sha256, installedAt: new Date().toISOString() }
updateState('binaries', s => { s.grin = result })
sse.emit('binary-installed', { name: 'grin', version: release.tag })
return result
```

### `installGrinWallet() → Promise<{version, path}>`

Same shape as `installGrin`, with:
- repo = `'grin-wallet'`
- pattern = `/grin-wallet-v.*-win-x64\.zip$/`
- inner exe name = `'grin-wallet.exe'`

### `installTor() → Promise<{version, path}>`

**Pinned** (not via GitHub API — Tor Project doesn't use GitHub releases
for the expert bundle):
```
TOR_VERSION = '13.0.10'                                  ← bump deliberately
TOR_URL     = `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_VERSION}/tor-expert-bundle-windows-x86_64-${TOR_VERSION}.tar.gz`
TOR_SHA256  = '<pinned hash>'                            ← record once verified
```

Flow same as `installGrin`, but:
- format: `tar.gz`
- inner exe: `tor/tor.exe`
- Also copy `tor/pluggable_transports/*` and required DLLs to `BIN_DIR/tor/`
  (Tor needs its DLL companions in the same dir)

### `installNssm() → Promise<{version, path}>`

**Pinned to NSSM 2.24** (architecture-defined):
```
NSSM_URL    = 'https://nssm.cc/release/nssm-2.24.zip'
NSSM_SHA256 = 'be7b3577c6e3a280e5106a9e9db5b3775931cefc7c3c44ed6828a0baa14e3858'
```

Flow same, inner = `nssm-2.24/win64/nssm.exe`.

### `installAll() → Promise<void>`

```
log.info('installer', 'installing all binaries')
await installGrin()
await installGrinWallet()
await installTor()
await installNssm()
log.info('installer', 'all binaries installed')
```

Runs sequentially (not parallel) — Tor + chain_data are both large and
ISP throttling kicks in on parallel downloads in practice.

**Used by:** `POST /api/setup/install-binaries`.

---

## app/lib/installer/toml.js

### `readToml(file) → object`

**Flow:**
```
raw = fs.readFileSync(file, 'utf8')
return iarna.parse(raw)
```

Trivial wrapper; exists so we can swap libs later if needed.

### `writeToml(file, data) → void`

**Flow:**
```
str = iarna.stringify(data)
tmp = file + '.tmp'
fs.writeFileSync(tmp, str, 'utf8')           ← never BOM
fs.renameSync(tmp, file)                      ← atomic
```

### `patchToml(file, mutations) → void`

**Purpose:** apply dotted-path mutations to a TOML file.

**Inputs:**
- `mutations: { [dottedKey: string]: any }` e.g.
  `{ 'server.api_http_addr': '127.0.0.1:13413' }`

**Flow:**
```
data = readToml(file)
for key, value of mutations:
    setDottedPath(data, key, value)
writeToml(file, data)

setDottedPath(obj, dotted, value):
    parts = dotted.split('.')
    cur = obj
    for i in 0 .. parts.length - 2:
        if cur[parts[i]] === undefined:
            cur[parts[i]] = {}
        cur = cur[parts[i]]
    cur[parts.last] = value
```

**Used by:** `node-config.js`, wallet init flow (Phase 5).

---

## app/lib/installer/node-config.js

### `generateNodeConfig({ network, mode }) → Promise<void>`

**Purpose:** create or refresh `grin-server.toml` for a node, plus
`.api_secret` / `.foreign_api_secret`.

**Inputs:**
- `network: 'mainnet' | 'testnet'`
- `mode: 'pruned' | 'full'`

**Side effects:**
- Writes `data/node-${network}/grin-server.toml`
- Writes `data/node-${network}/.api_secret` (if missing)
- Writes `data/node-${network}/.foreign_api_secret` (if missing)

**Flow:**
```
dataDir = paths.nodeDataDir(network)
fs.mkdirSync(dataDir, { recursive: true })

// 1. Generate default toml if absent — grin has a `server config` subcommand
configPath = path.join(dataDir, 'grin-server.toml')
if !fs.existsSync(configPath):
    args = network === 'testnet' ? ['--testnet'] : []
    args.push('server', 'config')
    await execFileInDir(paths.binaryPath('grin'), args, { cwd: dataDir })
    // grin writes grin-server.toml + .api_secret + .foreign_api_secret to cwd

// 2. Patch with our values
apiPort      = network === 'testnet' ? 13413 : 3413
p2pPort      = network === 'testnet' ? 13414 : 3414

mutations = {
    'server.api_http_addr':              `127.0.0.1:${apiPort}`,
    'server.p2p_config.host':            '0.0.0.0',
    'server.p2p_config.port':            p2pPort,
    'server.db_root':                    path.join(dataDir, 'chain_data'),
    'server.api_secret_path':            path.join(dataDir, '.api_secret'),
    'server.foreign_api_secret_path':    path.join(dataDir, '.foreign_api_secret'),
}
if mode === 'pruned':
    mutations['server.archive_mode']     = false
    mutations['server.chain_validation_mode'] = 'EnabledOnInit'

patchToml(configPath, mutations)

// 3. Ensure secrets exist (grin creates them on `server config`, but
//    older versions don't — belt-and-suspenders)
ensureSecret(path.join(dataDir, '.api_secret'))
ensureSecret(path.join(dataDir, '.foreign_api_secret'))

// 4. Update state
updateState('nodes', s => {
    existing = s.nodes.find(n => n.network === network && n.mode === mode)
    record   = { network, mode, dataDir, serviceName: catalog.serviceName({network, mode}), installed: false, lastSyncHeight: 0 }
    if existing: Object.assign(existing, record)
    else        s.nodes.push(record)
})

ensureSecret(path):
    if fs.existsSync(path): return
    secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(path, secret, 'utf8')      ← no BOM, no trailing newline
    fs.chmodSync(path, 0o600)                   ← best-effort on Windows
```

**Used by:** `POST /api/setup/configure-node`.

---

# Phase 3 — Service Management

## app/lib/services/sc.js

### `query(name) → {exists, state, startType} | null`

**Purpose:** parse `sc.exe query/qc` output into a struct.

**Flow:**
```
try:
    queryOut = execFileSync('sc.exe', ['query', name], { encoding: 'utf8' })
catch:
    return { exists: false }

state = /STATE\s+:\s+\d+\s+(\w+)/.exec(queryOut)?.[1]?.toLowerCase()
// state values: stopped, start_pending, stop_pending, running, …

qcOut = execFileSync('sc.exe', ['qc', name], { encoding: 'utf8' })
startTypeRaw = /START_TYPE\s+:\s+\d+\s+(\w+_\w+)/.exec(qcOut)?.[1]
startType = {
    'AUTO_START':   'auto',
    'DEMAND_START': 'demand',
    'DISABLED':     'disabled'
}[startTypeRaw] ?? 'unknown'

return { exists: true, state, startType }
```

**Error swallowing:** `sc.exe` returns non-zero when service doesn't
exist, which is fine. Distinguish "doesn't exist" (specific error code
1060) from real failures (e.g. access denied) and re-throw real failures.

### `start(name) → Promise<void>` / `stop(name) → Promise<void>`

```
start(name):
    s = query(name)
    if !s.exists: throw `service ${name} doesn't exist`
    if s.state === 'running': return
    execFileSync('sc.exe', ['start', name])
    // sc.exe returns immediately; service may still be in start_pending.
    // Poll query() every 500ms up to 30s waiting for 'running'.
    waitForState(name, 'running', 30000)

stop(name):
    s = query(name)
    if !s.exists: throw `service ${name} doesn't exist`
    if s.state === 'stopped': return
    execFileSync('sc.exe', ['stop', name])
    waitForState(name, 'stopped', 60000)    ← grin takes longer to stop (chain flush)
```

### `setStartType(name, type) → void`

```
flag = { auto: 'auto', demand: 'demand', disabled: 'disabled' }[type]
execFileSync('sc.exe', ['config', name, `start=`, flag])
```

Note the trailing `=` and the space — `sc.exe` quoting is famously
finicky. The form `start= demand` (with space after `=`) is required;
`start=demand` silently fails on some Windows versions.

### `deleteService(name) → void`

```
stop(name) if running, ignore failures
execFileSync('sc.exe', ['delete', name])
```

---

## app/lib/services/nssm.js

### `install(name, exe, args) → void`

**Purpose:** create a new Windows service that runs `exe args…`.

**Flow:**
```
nssmPath = paths.binaryPath('nssm')
execFileSync(nssmPath, ['install', name, exe, ...args])
log.info('services.nssm', `installed ${name}`)
```

### `setParams(name, params) → void`

**Purpose:** configure a service's NSSM parameters.

**Inputs:** `params: { AppDirectory?, AppStdout?, AppStderr?, AppExit?, AppRestartDelay?, ... }`

**Flow:**
```
for key, value of params:
    execFileSync(nssmPath, ['set', name, key, value])
```

**Typical config used by `installNodeService`:**
```
AppDirectory     = paths.nodeDataDir(network)
AppStdout        = path.join(paths.LOGS_DIR, `${name}.stdout.log`)
AppStderr        = path.join(paths.LOGS_DIR, `${name}.stderr.log`)
AppRotateFiles   = 1
AppRotateBytes   = 10485760              ← 10 MB
AppExit Default  = 'Restart'
AppRestartDelay  = 5000
AppStopMethodSkip = 0                    ← use Ctrl+C path (grin honours it)
AppStopMethodConsole = 30000             ← 30s for Ctrl+C to complete
```

### `remove(name) → void`

```
execFileSync(nssmPath, ['remove', name, 'confirm'])
```

---

## app/lib/services/catalog.js

### `serviceName({network, mode}) → string`

```
return `GrinNode-${capitalize(network)}-${capitalize(mode)}`
// e.g. 'GrinNode-Mainnet-Pruned'
```

### `nodeServiceFor({network, mode}) → ServiceSpec`

```
return {
    name: serviceName({network, mode}),
    exe:  paths.binaryPath('grin'),
    args: network === 'testnet' ? ['--testnet', 'server', 'run'] : ['server', 'run'],
    cwd:  paths.nodeDataDir(network)
}
```

### `allKnown() → ServiceSpec[]`

Reads `nodes.json`, returns spec for every node + tor + web (web is
optional; only included if registered).

---

## app/lib/api/services.js  (Express router)

### `POST /api/services/install-node`

**Body:** `{ network, mode }`

**Flow:**
```
1. spec = catalog.nodeServiceFor({network, mode})
2. existing = sc.query(spec.name)
3. if existing.exists:
       return 409 { error: 'service already installed' }
4. await nodeConfig.generateNodeConfig({ network, mode })       ← idempotent
5. nssm.install(spec.name, spec.exe, spec.args)
6. nssm.setParams(spec.name, {
       AppDirectory: spec.cwd,
       AppStdout:    path.join(paths.LOGS_DIR, `${spec.name}.stdout.log`),
       AppStderr:    path.join(paths.LOGS_DIR, `${spec.name}.stderr.log`),
       AppExit:      'Default Restart',
       AppRestartDelay: 5000,
       AppStopMethodConsole: 30000
   })
7. sc.setStartType(spec.name, 'demand')
8. updateState('nodes', s => {
       node = s.nodes.find(n => n.network === network && n.mode === mode)
       node.installed = true
       node.serviceName = spec.name
   })
9. return { ok: true, service: sc.query(spec.name) }
```

### `POST /api/services/start` `{ name }` — calls `sc.start`
### `POST /api/services/stop` `{ name }` — calls `sc.stop`
### `GET /api/services` — returns array of `{name, …catalog spec, ...sc.query}`

---

# Phase 4 — Node Integration (sketch)

## `app/lib/node/api-client.js`

### `ownerCall(network, method, params) → Promise<any>`

```
1. Read .api_secret for the network
2. POST http://127.0.0.1:<ownerPort>/v2/owner
     auth:  basic 'grin:<secret>'
     body:  { jsonrpc: '2.0', method, params, id: 1 }
3. if response.error: throw new Error(JSON.stringify(response.error))
4. result = response.result
5. if result.Ok !== undefined: return result.Ok                ← unwrap Rust Result
   if result.Err !== undefined: throw new Error(JSON.stringify(result.Err))
   else return result
```

`foreignCall(network, method, params)` — same shape but uses
`.foreign_api_secret` and `/v2/foreign`.

### `getStatus(network)` → `ownerCall(network, 'get_status', [])`
### `getConnectedPeers(network)` → `ownerCall(network, 'get_connected_peers', [])`

## `app/lib/installer/chaindata.js`

### `downloadChainData({ network }) → Promise<void>`

**Sketch:**
```
1. mirror = pickMirror(network)              ← list of known mirrors in code
2. dest = path.join(paths.nodeDataDir(network), 'chain_data.tar.gz')
3. await download({ url: mirror, dest, label: `chain_data ${network}` })
   ← supports resume via download()'s built-in Range logic
4. await extract({ archive: dest, dest: paths.nodeDataDir(network) })
5. fs.unlinkSync(dest)
6. validate: expected subdirs exist (header_mmr, kernel_mmr, output_mmr, txhashset)
7. updateState('nodes', …)
```

**To be deepened in Phase 4.**

## `GET /api/node/:network/status` (sketch)

```
1. service = sc.query(catalog.serviceName({network, mode}))
2. if !service.exists or service.state !== 'running':
       return { installed: false, running: false }
3. status = await ownerCall(network, 'get_status', [])
4. return {
       installed: true,
       running:   true,
       tipHeight: status.tip.height,
       headerHeight: status.header_head?.height,
       syncing:   status.sync_status !== 'no_sync',
       connections: status.connections,
       userAgent: status.user_agent
   }
```

---

# Phase 5 — Wallet Integration (sketch)

## `createWallet({ name, network, passphrase }) → Promise<{seedWords}>`

**Sketch:**
```
1. dir = paths.walletDataDir(name)
2. mkdir dir
3. args = network === 'testnet' ? ['--testnet'] : []
   args.push('--top_level_dir', dir, 'init', '-p', passphrase)
4. spawn grin-wallet, collect stdout
5. parse 24-word seed from stdout (regex: /^\d+\. (\w+)$/m × 24)
6. patchToml(dir + '/grin-wallet.toml', { ports + secret paths })
7. updateState('wallets', s => s.wallets.push({ name, network, dir, foreignPort, ownerPort }))
8. sessions.set(name, { passphrase, listenerProc: null, ownerProc: null })
9. return { seedWords }   ← shown ONCE in UI, user confirms 3 random positions
```

## ECDH session (sketch — verbatim port from prior reference impl)

A working reference exists at
`d:\Git_noob\GrinSuite\web\03_web_wallet\server.js` (lines ~32-180).
Port without logic changes — just refactor into a module.


```
init_secure_api flow:
  1. POST init_secure_api { ecdh_pubkey: ourPubHex } → serverPubHex
  2. sharedSecret = ECDH compute (P-256)
  3. open_wallet  via encryptedCall(sharedSecret, 'open_wallet', { name, password })
       → token
  4. all subsequent calls use encryptedCall(sharedSecret, method, { token, ...params })

encryptedCall(key, method, params):
  nonce  = randomBytes(12)
  body   = JSON.stringify({ jsonrpc:'2.0', method, params, id:1 })
  cipher = aes-256-gcm encrypt body with key + nonce
  payload = { nonce: nonceHex, body: cipherHex }
  POST { method:'encrypted_request', params:[payload] } → response
  decrypt response.result with key + responseNonce → plain JSON
  return plain.result.Ok / throw plain.result.Err
```

## Wallet listener spawn (sketch)

```
spawn grin-wallet --top_level_dir=<dir> listen --method=http --port=<foreignPort>
  detached: true, stdio piped to log files
  store ChildProcess in sessions.get(name).listenerProc
  on exit: log + emit 'listener-died' event
```

---

# Phase 6 — Tor (sketch)

### Tor service registration
```
sc.create('tor', exe: paths.binaryPath('tor'), args: ['-f', paths.BIN_DIR + '/tor/torrc'])
sc.setStartType('tor', 'auto')                  ← Tor is small; can be always-on
```

### Onion provisioning
```
provisionOnion(walletName):
  hsDir = paths.walletDataDir(walletName) + '/tor'
  mkdir hsDir
  appendToTorrc(`
    HiddenServiceDir ${hsDir}
    HiddenServicePort 80 127.0.0.1:${foreignPort}
  `)
  sc.stop('tor'); sc.start('tor')
  poll for hsDir + '/hostname' (Tor writes it within ~5s)
  onion = readFile(hsDir + '/hostname').trim()
  updateState('wallets', s => find(walletName).onion = onion)
  return onion
```

---

# Phase 7 — Setup Wizard (sketch)

### Wizard guard middleware

```
app.use((req, res, next) => {
    const app = readState('app')
    if (app.firstRunComplete) return next()
    if (req.path.startsWith('/setup/') || req.path.startsWith('/api/setup/')) return next()
    if (req.path === '/' || req.path === '/api/events') return next()
    res.redirect('/setup/welcome')
})
```

### State machine

```
Steps in order: welcome → network → binaries → node → wallet → tor → done
Each /setup/<step> renders a static HTML page with embedded JS that:
  - kicks off the relevant /api/setup/* action
  - subscribes to /api/events for progress
  - on completion, navigates to /setup/<next>
On reaching /setup/done:
  POST /api/setup/complete  →  writeState('app', { ...current, firstRunComplete: true })
  redirect to /
```

---

# Phase 8 — Dashboard (sketch)

Static HTML at `/`. Loads:
- Wallet panel: `GET /api/wallets/:name/summary` every 5s
- Node panel:   `GET /api/node/:network/status` every 3s
- Subscribes to `/api/events` for instant updates (no polling lag on actions)

Sections rendered as plain HTML — each panel is a `<section>` with its
own JS module under `app/public/js/panels/<name>.js`. No framework.

---

# Phase 9 — Self-Update (sketch)

### `POST /api/update`

```
1. hasGit = !!commandPath('git')
2. if hasGit and isGitWorkingTree(paths.INSTALL_ROOT):
       await execInDir('git fetch')
       diff = await execInDir('git log HEAD..origin/main --oneline')
       if !diff: return { ok: true, alreadyLatest: true }
       return { ok: true, mode: 'git', diff }
   else:
       latest = github.latestRelease('noobvie', 'Grin-Money-Desktop', /Source code.*zip/)
       return { ok: true, mode: 'zip', tag: latest.tag }

POST /api/update/apply { confirm: true }
  if mode === 'git':
      await execInDir('git pull --ff-only')
  else:
      tempZip = paths.TEMP_DIR + '/update.zip'
      await download({ url: latest.url, dest: tempZip })
      tempExtract = paths.TEMP_DIR + '/update-extract'
      await extract({ archive: tempZip, dest: tempExtract })
      ROBOCOPY tempExtract paths.INSTALL_ROOT /MIR /XD state data logs node_modules
  await execInDir('npm install --omit=dev', paths.INSTALL_ROOT + '/app')

  // schedule restart
  spawn detached: cmd /c "timeout 2 && Grin-Money-Desktop.bat"
  setTimeout(() => process.exit(0), 1000)
```

Browser polls `/api/health` after seeing the restart event. When the
version string changes, full reload.

---

# Cross-Cutting Helpers

## `app/lib/util/exec.js`

### `execFile(cmd, args, opts) → Promise<{stdout, stderr}>`
### `execFileSync(cmd, args, opts) → string`

Thin promise wrappers over `child_process.execFile`. Reasons to have
these instead of using execFile directly everywhere:
- Default `windowsHide: true` (no flash of cmd window)
- Default 30s timeout
- Decode `cp437` if specified (some Windows tools output in console codepage)

### `commandPath(cmd) → string | null`

`where.exe cmd` → first line if exit 0, null if exit non-zero. Used to
detect git, node, etc. without using `Get-Command` (PS).

---

# What This Doc Does NOT Cover

- **Concrete TypeScript signatures** — pseudocode style chosen so we can
  discuss logic without typo-fixing imaginary types
- **Test plan** — separate doc once Phase 1 lands
- **UI HTML structure** — sketched in Phase 7-8 only; deep UI design is
  separate from API logic
- **Configuration knobs exposed to users** — covered when settings panel
  is built in Phase 8

When you start a phase, treat the matching section of this doc as a
**draft to refine in the same PR** — pseudocode that survives contact
with real code is rare. Update this doc when reality diverges from plan.
