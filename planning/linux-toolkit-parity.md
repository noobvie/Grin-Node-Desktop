# Script 01 parity — what the Linux toolkit does, and how this app does the same

The Linux [Grin Node Toolkit](https://github.com/noobvie/Grin-Node-Toolkit) Script 01 is the
reference for node management. This file records its contracts (read from the bash source on
2026-11-09) and the Windows mapping each module implements. When the two differ, the
"Windows" column is the decision and says why.

## 1. Chain data

| Topic | Linux toolkit | Windows (this app) |
|---|---|---|
| Mirror registry | `extensions/grinmasternodes.json`: `{ "<zone>": { "<site_key>": ["host", …] } }`, zones `america asia europe africa`; keys starting `_` are metadata | Same shape, embedded as data in `installer/chaindata-mirrors.js` (no registry file to ship). Keep the host list identical. |
| Site key | `fullmain` \| `prunemain` \| `prunetest` (mode short + net short) | Same strings; `siteKey({network, mode})`. |
| Hosts | america: `fullmain.grin.money`, `fullmain.grinnode.org`, `prunemain.grin.money`, `prunemain.grinnode.org`, `prunetest.grin.money`, `prunetest.grinnode.org` · asia: `prunemain.onlygrins.com`, `prunetest.grinily.com` · europe: `fullmain.onlygrins.com`, `prunemain.grinily.com`, `prunetest.onlygrins.com` · africa: none | Identical. Base URL is always `https://<host>`. |
| Zone choice | Menu 1–4 or Auto = all zones; empty zone falls back to america; hosts de-duplicated and shuffled | Auto only (all zones, shuffled). No zone menu. |
| Manifest fast path | `GET <base>/chaindata.json`, 10 s. Fields: `schema`, `site_key`, `network`, `node_type`, `archive_mode`, `archive` (`^[A-Za-z0-9._-]+\.tar\.gz$`), `checksum_file` (`^[A-Za-z0-9._-]+\.sha256$`), `sha256` (64 hex, optional), `size_bytes`, `generated_utc` (`YYYY-MM-DDTHH:MM:SSZ`), `generator`. `site_key` must equal the expected key; age from `generated_utc`; then `HEAD <base>/<archive>` must succeed. Any doubt → legacy probes | Same, `fetch` with `AbortSignal.timeout(10_000)`. |
| Legacy probes (fallback) | 1 `HEAD <base>/` (8 s) — `Last-Modified` within limit if present · 2 `GET <base>/check_status_before_download.txt` (15 s) must contain `Sync completed.` · 3 `GET <base>/` (15 s), first `href="…\.tar\.gz"` and `href="…\.sha256"`; the tar name must contain `full`+`mainnet`, `pruned`+`mainnet` or `pruned`+`testnet` (case-insensitive) · 4 `HEAD <base>/<tar>` (10 s) | Same four steps, same timeouts. |
| Freshness | `fullmain` 70 days, others 5 days; `age_days = floor((now − ts)/86400)`, reject if `> max` | Same. |
| Archive name | `grin_<full\|pruned>_<mainnet\|testnet>_YYYYMMDD.tar.gz` + `<base>.sha256` | Same (comes from the mirror). |
| Checksum file | `<hex>  <filename>` (two spaces) | Parse the first field; compare case-insensitively with the manifest `sha256` when present — mismatch is fatal before download. |
| Download modes | 1 stream (`wget -O - \| tar -xzf -`, no SHA check) · 2 download then verify then extract · 3 slow sync | **Download → verify SHA256 → extract** only (stream mode skips verification; a desktop has the disk). Resume via `download.js` `.part`. Slow sync = "skip chain data" button. |
| Disk check | Extract: `tar_size × 1.2` free on `/`. Fresh install: 25 GiB full / 10 GiB pruned on the node dir's volume | Before download: `requireFree(nodeDir, size × 2.3)` when size known (archive + extracted + slack); fresh install gate 25 / 10 GiB on `INSTALL_ROOT`'s volume. |
| Extraction | existing `chain_data/` removed first (default); `tar -xzf … -C <dir>`; archive has one top-level dir `chain_data/`; `lmdb/lock.mdb` and `peer/lock.mdb` excluded; **no layout check after extraction**; tar + sha deleted on success | Through `extract.js` (tar `strict`). The existing `chain_data/` is removed only **after** the archive is downloaded and SHA-verified, so a failed probe or checksum never destroys a working chain. Added: fail if neither `<dir>/chain_data/multi_lmdb` (grin 5.5) nor `<dir>/chain_data/lmdb` (older) exists after extraction — cheap and catches a wrong archive. `<dir>/.chaindata-incomplete` exists from the removal of the old tree until that check passes; while it is there Start is refused. Added: only plain files and directories at or below `chain_data/` are accepted; any other entry (a top-level `grin.exe`, a link, a `..` or backslash path) fails the extraction, because the node dir also holds the service binary and the SHA256 only proves what the mirror published. |
| Failure handling | Next ready source once each; `rm -rf chain_data` on a failed stream | Next source once each; a failed/aborted extraction removes `chain_data/` (guarded by `paths.assertInsideData`) and the archive. A network failure keeps the `.part` for the next run; leftovers of a differently named archive are removed on entry. |

## 2. Node config

| Topic | Linux toolkit | Windows |
|---|---|---|
| Node dirs | `/opt/grin/node/mainnet-full`, `mainnet-prune`, `testnet-prune` (no testnet full) | `data/node-mainnet/`, `data/node-testnet/` — one dir per network; mode lives in the toml (`archive_mode`) and `nodes.json`. No testnet full. |
| Template | None: `./grin [--testnet] server config` run inside the dir with `HOME=<dir>`; first `grin-server.toml` found is moved to the dir root; an existing toml → `grin-server.toml.bak.<epoch>` | `grin.exe [--testnet] server config` with `cwd = nodeDir`; same move/backup rules, but the backup is taken **before** running `server config` — grin exits with "already exists in the current directory" otherwise. grin reads the toml from the current directory first, so the service's `AppDirectory` must be the node dir. |
| Keys patched | `archive_mode` true/false · `db_root "<dir>/chain_data"` · `log_file_path "<dir>/grin-server.log"` · `api_secret_path "<dir>/.api_secret"` · `foreign_api_secret_path "<dir>/.foreign_api_secret"` · `peer_max_inbound_count 999` · `peer_max_outbound_count 199` · `peer_min_preferred_outbound_count 199` · `log_max_files 10` · `file_log_level "Debug"` · `stdout_log_level "Debug"` (the bash patcher matches a bare key name wherever it sits) | Same keys and values, addressed by table: `server.*` for the node keys, `logging.*` for `log_file_path`, `log_max_files`, `file_log_level`, `stdout_log_level` (that is where grin writes them). Windows paths are escaped by `@iarna/toml`, which also prints integers ≥ 1000 as `3_414` — valid TOML, grin parses it. Limitation: `@iarna/toml` re-serialises a whole-number float as an integer (`1.0` → `1`), which grin would reject for an `f64` field; `grin-server.toml` has no float-valued key today (checked against `test/fixtures/grin-server.sample.toml`), so `installer/toml.js` does nothing about it — revisit if grin adds one. **Except**: `run_tui = false` (grin's TUI has no console under a service — on Linux tmux provides one) and `stdout_log_level = "Warning"` (NSSM already captures stdout to a file; two Debug logs would double disk writes). |
| Deliberately untouched | `enable_stratum_server` (default false), p2p `host` (grin 5.5 defaults to `"::"`), `api_http_addr`, `chain_type`, ports | Same. |
| Re-patch at start | `log_file_path`, `api_secret_path`, `foreign_api_secret_path` rewritten to the current dir before every start | Same four path keys incl. `db_root`, in `node-config.repatchPaths`, called by `ops-lifecycle.startNode`. |
| Secrets | 20 chars `[A-Za-z0-9]`, no trailing newline; files `<dir>/.api_secret`, `<dir>/.foreign_api_secret`; vault `/opt/grin/keys/<net>/` (700/600). Order per file: vault valid → restore into dir; else dir valid → adopt into vault; else generate both. Valid = trimmed length 8–128, printable | Same generator (`crypto.randomInt` over the 62-char alphabet), same order and validity rule; vault = `state/secrets/<network>/` under `INSTALL_ROOT`. Written with `fs.writeFileSync(p, s, 'utf8')` (no BOM). |

## 3. Binary

| Topic | Linux toolkit | Windows |
|---|---|---|
| Lookup | `GET https://api.github.com/repos/mimblewimble/grin/releases/latest`, 30 s; version = `tag_name`; asset matches `linux-x86_64\.tar\.gz$` | Same endpoint; asset `win-x86_64\.zip$`; **also** download `…-win-x86_64-sha256sum.txt` and verify (the Linux script does not). That file is PowerShell `Get-FileHash` output (`Algorithm : SHA256 / Hash : <HEX> / Path : …`), not coreutils `<hex>  <file>`; `github.parseSha256Sum` accepts both plus a lone hex token. |
| Install | first file named `grin` → `install -m 755 <dir>/grin` | `grin.exe` from the zip → `bin/grin.exe` (store copy, recorded in `binaries.json`), then copied to `<nodeDir>/grin.exe` per node (module-layout.md §3). |
| `update_binary_only` | download once · per network, mainnet first: stagger 1000 s if the previous node was launched → re-scan, `was_running` → stop → `cp grin grin.prev` (+ archive to `/opt/grin/bin`) → `install` new → on failure restore `grin.prev` → start **only if was_running**; a stopped node stays stopped | Same sequence without the stagger (a desktop has no consumers that need one node up). `grin.prev` kept beside the exe; `bin/grin.exe` is the archive copy. Confirm the process is gone before the swap: Windows lets a running exe be renamed, so nothing else stops the old binary from running on as `grin.prev`. |

## 4. Node scan (one scan, every screen)

| Field | Linux rule | Windows rule |
|---|---|---|
| installed | `grin-server.toml` is a file **and** `<dir>/grin` executable | `grin-server.toml` **and** `<dir>\grin.exe` exist |
| running | a `grin server run` process whose resolved exe == `<dir>/grin`; never a port check | a `grin.exe` process (`Get-CimInstance Win32_Process`) whose `ExecutablePath` sameFile `<dir>\grin.exe`; never a port check |
| mode | dir suffix, else toml `archive_mode` | toml `archive_mode`, else `nodes.json` |
| version | last word of `grin --version` | same, cached by exe mtime |
| session | gtmux / root tmux / none | `service: { exists, state, startType }` from `sc.query` on the network's service name (either mode); `staleServices`: a service for the other mode |
| foreign holder | `ss -tlnp` holder of 3414/13414 whose exe basename ≠ `grin` → red line, pid never signalled | `tcpListener(p2p)` whose exe is not this node's `<dir>grin.exe` (another program, or a grin.exe from another folder) → `foreignHolder`, never killed |
| autostart | crontab tag line; `on` (same dir) / `stale` (other dir) / `off` | service `startType === 'auto'` and `nssm get <name> Application` sameFile `<dir>\grin.exe` → `on`; auto but another path → `other-dir`; else `off` |
| extra dir | a second installed dir for the network | n/a (one dir per network) |
| Allowed actions | start: installed ∧ ¬running · stop: running · update: installed · rebuild: dir set · install: no dir | start: installed ∧ ¬running · stop: running **or a service of the network not `stopped`** (NSSM restarts a crashed grin every 5 s, so a crash-looping node must be stoppable) · update / rebuild: installed · rollback: installed ∧ `grin.prev` exists · install: not installed. Start and stop answer 409 while a job holds the network. |

## 5. Actions

| Action | Linux sequence | Windows sequence |
|---|---|---|
| stop | planned-stop marker → SIGTERM → poll 2 s up to 300 s → SIGKILL → kill tmux session → sweep leftovers (10 s grace) | `sc.stop` (NSSM sends Ctrl+C, `AppStopMethodConsole 300000`) → poll until `stopped` (≤ 330 s) → any `grin.exe` still running from `<dir>` after 10 s → `taskkill /T /F` on that pid only |
| start | fail if not installed · running with session → ok · orphan → SIGKILL · re-patch 3 path keys · launch via tmux as `grin` with `HOME=<dir>` · "starts within 30 s" | fail if not installed or chain_data is a partial extraction · service running → ok · service in another live state (PAUSED) → stopped first · orphan (process, service not running) → taskkill · re-patch 3 path keys · service missing → `installService` (NSSM) · service wrapped by another folder's `nssm.exe` → removed and registered again · `sc.start` · PAUSED right after the start → `failed` · report `launched` \| `running` \| `failed`, never throw past the caller |
| rebuild chain_data | refuse outside `/opt/grin/node`, refuse if toml/binary missing, typed `REBUILD`, stop, **refuse if a process of the dir is still alive**, `rm -rf chain_data` only, download, extract, start, conf rewritten | refuse unless `assertInsideData(dir)`, refuse if toml/exe missing, UI confirms with typed `REBUILD`, stop when the node is up (process alive or service not `stopped`), refuse unless the service is `stopped` and no process remains, download → verify → then replace `chain_data/` only (a failed download leaves the old chain and restarts a node that was running), start if it was running. Keeps toml, secrets, exe. |
| full reinstall | typed `REBUILD` / `DELETE-ARCHIVE` (full) · stop · `rm -rf` dirs under `/opt/grin/node` · conf lines removed · wizard; secrets restored from vault; .onion kept | typed token the same (`DELETE-ARCHIVE` unless the mode is positively pruned) · preflight before anything is removed (mode/start type valid, store binaries present, a chain-data source ready) · stop · remove both mode services · `rm` nodeDir (assertInsideData) · `installNode({network, mode})`; secrets restored from `state/secrets/`. A plain install refuses an already-installed network (409). |

## 6. Owner API

- URL `http://127.0.0.1:<3413|13413>/v2/owner`, body `{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}`, HTTP Basic `grin:<.api_secret>`, `Content-Type: application/json`, timeout 3 s (toolkit uses 4–8 s; the desktop UI polls every 5 s).
- Unwrap: `result.Ok` → value; `result.Err` → throw `Error(JSON.stringify(Err))`; no `Ok`/`Err` → throw. Never read `result` directly.
- Fields: `tip.height`, `tip.total_difficulty`, `sync_status` (`no_sync` = synced), `sync_info.{highest_height,current_height,downloaded_size,total_size}`, `connections` (a **string** → `parseInt`), `protocol_version`, `user_agent`.
- There is no `/v1/`; `get_status` over `get_tip`.

## 7. Numbers

Ports: P2P 3414/13414 · API 3413/13413 · stratum 3416/13416 (grin default, untouched); 3415/13415 and 3420/13420 are wallet ports and never a node conflict. GitHub API 30 s. Mirror probes 10/8/15/15/10 s. No retry loops — each ready source is tried once. Hashrate `GPS = diff_delta × 42 / block_time_seconds / 16384`, units G/s, kG/s ≥ 1 000, MG/s ≥ 1 000 000.
