# Security Model — Grin Node Desktop

This document is the **source of truth** for what this wallet protects
against, what it doesn't, and the reasoning behind every security
tradeoff. Read this before making changes that touch keys, secrets,
network calls, or process spawning.

> **One-line summary:** local-only wallet, all secrets in memory or
> short-lived files, downloads SHA-pinned, no telemetry, no network
> service exposed beyond `127.0.0.1`. Defends against opportunistic
> malware and naïve attackers. **Does not defend** against keyloggers,
> screen recorders, or anyone with extended physical access to an
> unlocked machine.

---

## 1. Trust boundaries

```
┌────────────────────────────────────────────────────────────────┐
│ Outside (cannot be trusted)                                    │
│  • Internet (ISP, public networks)                             │
│  • Other processes on the same Windows account                 │
│  • Browser extensions (run inside the browser process)         │
│  • Other Windows accounts on the same machine                  │
└────────────────────────────────────────────────────────────────┘
                                ▲
                                │ TLS (install.ps1, GitHub, mirrors)
                                │ Tor (sends/receives via .onion)
                                │ P2P (grin.exe ↔ Grin network)
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Trust zone A — the user's Windows session                      │
│  • Browser (Chrome/Edge/Firefox)                               │
│  • Node.js process (app/server.js)                             │
│  • Localhost HTTP at 127.0.0.1:7420                            │
│  • Localhost grin node APIs (3413, 13413)                      │
│  • Localhost wallet APIs (3415/3420, 13415/13420)              │
└────────────────────────────────────────────────────────────────┘
                                ▲
                                │ Filesystem (NTFS ACLs)
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Trust zone B — files on disk                                   │
│  • D:\Grin\data\wallets\<name>\wallet_data\db\  (encrypted)    │
│  • D:\Grin\data\wallets\<name>\.owner_api_secret               │
│  • D:\Grin\data\wallets\<name>\.foreign_api_secret             │
│  • D:\Grin\data\node-*\.api_secret                             │
│  • D:\Grin\bin\*.exe                                           │
└────────────────────────────────────────────────────────────────┘
                                ▲
                                │ In memory only
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Trust zone C — RAM during a session                            │
│  • Wallet passphrase (only here, NEVER on disk)                │
│  • ECDH shared secret for wallet Owner API session             │
│  • Decrypted seed words during 24-word display                 │
└────────────────────────────────────────────────────────────────┘
```

**Rule of thumb:** the further inward a secret is, the more sensitive
it is. Passphrase (zone C) > on-disk secrets (zone B) > localhost
traffic (zone A) > internet traffic.

---

## 2. What this wallet protects against

### Network attackers

| Attack | Mitigation |
|---|---|
| ISP / WiFi MITM reading the install one-liner | `https://grinnode.org/install` over TLS 1.2+ (grin.money/install redirects there); nginx serves with HSTS; marker line and SHA256 verified after deploy; checksum published at `/install.ps1.sha256` |
| MITM tampering with binary downloads (grin.exe, etc.) | SHA256 pinned in code; mismatch → install aborts |
| Attacker port-scanning user's machine, hitting wallet API | All wallet/node APIs bind to `127.0.0.1` only — never `0.0.0.0` |
| Attacker reaching the local UI through Wi-Fi | Same — only `127.0.0.1:7420`; we never listen on a network interface |
| Tor exit node correlating sender ↔ receiver | Tor sends use `.onion` ↔ `.onion` (no exit node involved); Tor receives expose a hidden service, recipient identity protected by Tor's circuit construction |
| Tor descriptor enumeration | Use Tor v3 onion services only (default in current Tor); v2 deprecated |

### Local malware

| Attack | Mitigation |
|---|---|
| Generic clipboard hijacker swapping a slatepack | **Confirmation dialog parses the pasted slatepack** and shows resolved recipient + amount before signing — user must confirm last 4 chars on amounts above a threshold |
| Process injection reading wallet memory | Cannot fully prevent — but passphrase is held in a single buffer that's zeroed on logout; lifetime minimized |
| Filesystem scanner finding `.wallet_pass` files | We deliberately do **not** create a `.wallet_pass` file. Passphrase lives in RAM only |
| Attacker reading `.api_secret` files | Stored under user-profile ACLs (default NTFS); secrets only used for localhost calls (no remote exposure) |
| Malware tampering with `grin.exe` between runs | NSSM service runs `grin.exe` from `D:\Grin\bin\grin.exe` — same path each launch; modifications would change the on-disk SHA, which `app/lib/installer/binaries.js` re-verifies on each install/upgrade |

### Supply chain

| Attack | Mitigation |
|---|---|
| Compromised `install.ps1` on grin.money | Deploy gate (manual `site_manager.sh --action deploy-installer`); signature-line check before nginx serves it; future: Authenticode sign the script |
| Compromised `grin.exe` from a fake GitHub release | We pull `latest_release` directly from GitHub API; release tags can only be pushed by repo maintainers; SHA256 of the downloaded archive recorded for cross-install verification |
| Compromised npm dependency | Lock file pinned (`package-lock.json` committed); minimal deps (express + tar + yauzl + @iarna/toml + simple-git); `npm audit` in CI on every PR |
| Compromised NSSM | NSSM pinned to build 2.24-101-g897c7ad with a known-good SHA256 |
| Compromised Tor expert bundle | Tor version pinned with SHA256; bundle fetched over HTTPS from `archive.torproject.org` |
| Backdoor in a PR from a contributor | Maintainer review on every PR; release tags signed; publishing to grinnode.org/install is a manual option G run by default; option G can also run hourly from cron (`--auto-confirm`), which publishes `main` HEAD with no human in the loop — use it only during development. Open: signed tags verified by option G and checked out by both installers |

### User-error footguns

| Mistake | Mitigation |
|---|---|
| User pastes a slatepack from a phishing site that asks for "wallet recovery" | Recovery flow is **only** in the local UI; the UI never asks for a slatepack to recover — only the 24-word seed |
| User sends entire balance to a typo'd address | Confirmation dialog showing resolved address + amount; "type the last 4 chars" gate above N grin |
| User loses passphrase | We can never recover it — but seed words can recreate a fresh wallet (won't restore tx history; will restore unspent outputs) |
| User loses seed words | Cannot recover. **The single most documented warning in the UI.** |
| User installs on OneDrive-synced folder | install.ps1 picks `D:\Grin\` / `C:\Grin\` — not user profile, not OneDrive territory |
| User exposes the local UI via Tailscale / port forwarding | We bind to 127.0.0.1 only — port forwarding requires deliberate action by the user; we cannot defend against intentional exposure |

---

## 3. What this wallet does NOT protect against

These are not "bugs" — they're explicitly out of scope. Document them
so users understand the limits.

### Physical access to the machine

- An attacker with extended physical access to an **unlocked** Windows
  session can use the wallet directly (we can't distinguish them from
  the legitimate user).
- An attacker with hours of physical access can install a keylogger,
  read memory, or replace `grin.exe`.
- Cold-boot RAM extraction could recover the in-memory passphrase
  while the wallet is unlocked.
- **Mitigation is the user's responsibility:** screen lock, full-disk
  encryption (BitLocker), don't share the Windows account.

### Active malware on the machine

- A **keylogger** captures the passphrase as the user types it. We
  can't prevent this.
- A **screen recorder** captures everything shown, including the seed
  words during initial display.
- A **RAT (remote access trojan)** can drive the UI as the user. The
  wallet has no way to distinguish "the user" from "malware controlling
  the user's input devices."
- **Mitigation:** keep Windows + browser up to date; don't run as
  Admin for daily browsing; AV / EDR.

### Browser-side compromise

- Malicious browser extensions can read the wallet UI's DOM, intercept
  localhost `fetch()` calls, and modify displayed amounts before the
  user sees them.
- A compromised browser process can do everything the user can do.
- **Mitigation:** use a separate browser profile (or a separate
  browser) for the wallet; install only trusted extensions.

### Targeted attacks

- Nation-state actors who specifically want **this user's** coins
  have far more resources than this wallet defends against.
- Zero-days against Windows, Node.js, Tor, or grin itself are above
  our threat model.
- Side-channel attacks (electromagnetic, timing, power analysis) are
  not considered.

### Recovery if you lose both passphrase AND seed words

- **There is no recovery.** Funds are gone. This is a property of
  cryptocurrency, not a bug we can fix.

### Loss after wallet pruning horizon

- Grin has a rangeproof horizon (~1 week). Outputs older than this
  cannot be recovered by chain rescan alone — they need wallet
  metadata that's stored in `wallet_data/`.
- **Implication:** restoring from seed words after losing the wallet
  may not recover old outputs. The user-facing recovery UI must warn
  about this.

---

## 4. Threat actors considered

| Actor | Capability | In scope? |
|---|---|---|
| Opportunistic malware | Reads files, watches clipboard, scans known wallet paths | ✅ Yes |
| Curious housemate / coworker (locked machine) | Cannot read RAM; can read non-encrypted files if they get a session | ✅ Yes |
| Public WiFi attacker | Passive sniffing + active MITM on user's outbound traffic | ✅ Yes |
| Compromised npm dependency author | Adds malicious code to a package we depend on | ✅ Yes (lockfile + minimal deps) |
| Bad-faith PR contributor | Submits subtly malicious code | ✅ Yes (review process) |
| Operator of a public Grin node we connect to | Sees our IP if we don't use Tor; learns what we sync | ✅ Partial (Tor optional for node connections; full when sending) |
| Operator of a chain_data mirror | Learns "this IP downloaded chain_data" | ✅ Partial (TLS; future: download chain via Tor) |
| Curious housemate / coworker (unlocked machine) | Full access to wallet UI | ❌ No — user's responsibility |
| Keylogger / RAT already on machine | Reads passphrase, controls UI | ❌ No — out of scope |
| Nation-state actor targeting this specific user | Zero-days, supply-chain attacks, physical surveillance | ❌ No |
| Evil maid (extended physical access) | Replaces binaries, installs persistence | ❌ No |
| Quantum adversary | Breaks current crypto | ❌ No (not a current threat) |

---

## 5. Cryptographic primitives in use

All chosen because they're what upstream Grin and Tor already use —
we don't roll our own.

| Use | Primitive | Where it's used |
|---|---|---|
| Wallet Owner API session | ECDH (P-256) + AES-256-GCM | grin-wallet's Owner API v3 |
| Wallet on-disk encryption | grin-wallet's native scrypt+ChaCha20-Poly1305 | wallet_data db |
| Mimblewimble transaction signing | Schnorr signatures (secp256k1) | grin-wallet internals |
| Tor circuit construction | Tor's native (curve25519, ed25519, AES-CTR) | All Tor-routed sends |
| TLS for install / mirror downloads | TLS 1.2+ (system stack) | install.ps1, binary downloads |
| Binary integrity | SHA-256 | All downloaded binaries |
| Random secret generation | `crypto.randomBytes(32)` (Node `crypto` module) | `.api_secret` / `.foreign_api_secret` files |

**Rule:** if a future feature needs new crypto, it must use one of the
above primitives or a Node `crypto` module function. No third-party
crypto libraries. No custom protocols.

---

## 6. Specific Grin-protocol considerations

### Slatepack interception

When sending via slatepacks (not Tor direct), three messages bounce:
S1 (sender) → S2 (receiver) → S3 (sender finalizes).

- **If S1 is intercepted and replaced:** the attacker can't construct
  a valid S2 without knowing the sender's outputs. Safe.
- **If S2 is intercepted and replaced:** an attacker who builds their
  own S2 (with their pubkey) could trick the sender into finalizing a
  send to the attacker. **This is a real risk.**
- **Mitigation:** the UI must show the recipient's address (from the
  S2) before the sender finalizes. The sender confirms it matches who
  they sent S1 to. Above an amount threshold, require the sender to
  type the last 4 chars of the resolved address.

### Tor send vs slatepack send

Tor (direct .onion ↔ .onion) is the safer flow: no slatepack to
intercept, no copy/paste exposure. **The wizard defaults Tor to ON**
for this reason. UI should encourage Tor-when-available.

### Loss of wallet_data after seed restore

The seed restores spending ability for outputs still tracked on chain,
but **loses transaction history, payment proofs, and labels**. Cannot
recover from seed:
- Sent transactions that completed before seed restore
- Transaction labels / notes / contacts
- Payment proofs for past sends

UI must warn about this **before** the user clicks "Recover from seed."

---

## 7. Logging and telemetry policy

**No telemetry. No analytics. No crash reports sent off-machine.**

- All logs stay on disk in `D:\Grin\logs\` and never leave the machine.
- We do not phone home, ever.
- We do not collect IP, OS version, install timestamp, or any other
  fingerprint.
- The only network calls during normal operation:
  - Grin P2P (via grin.exe) → other Grin nodes
  - Wallet sends → Tor or peer .onion
  - Self-update check (user-initiated) → GitHub API + `grin.money`
  - Binary upgrades (user-initiated) → GitHub releases

If we ever add opt-in crash reporting, it must be **opt-in** with a
clear UI, document exactly what's sent, and use a server we control
(not Sentry/Datadog/etc. — those are third-party data leaks).

---

## 8. Code-level rules (for contributors)

When reviewing PRs, reject any change that:

1. **Persists a passphrase or private key to disk** in any form
2. **Logs a passphrase, seed word, private key, or API secret** to
   console, file, or SSE event
3. **Binds a wallet/node port to `0.0.0.0`** instead of `127.0.0.1`
   (P2P is the only exception)
4. **Adds an npm dependency** without justification + audit
5. **Disables SHA256 verification** on a binary download
6. **Adds a `User-Agent`-or-similar identifier** to outbound requests
   that could fingerprint the user
7. **Sends data to an external service** without explicit user opt-in
   (this includes Sentry, Datadog, Mixpanel, GA, Cloudflare Insights,
   anything)
8. **Caches the passphrase** in a way that survives process restart
9. **Adds a CORS allow-origin** other than the local UI's origin
10. **Uses `eval`, `new Function`, or similar dynamic code execution**

When in doubt, ask in the PR. The threshold for "OK with reservations"
on security-touching code is higher than for the rest of the codebase.

---

## 9. Open security questions (to revisit)

1. **HTTPS for the local UI** — currently HTTP on 127.0.0.1. A
   malicious local process could in theory MITM the loopback traffic.
   Adding a self-signed cert is possible but adds browser warning UX
   pain. **Decision deferred** until we have a concrete attack
   scenario; opportunistic malware doesn't typically MITM loopback.
2. **Authentication on the local UI** — currently no auth (anyone who
   can reach 127.0.0.1:7420 from this Windows account can use the
   wallet). Add a session cookie + unlock-on-first-action? Probably
   yes once we have multi-user awareness; defer for v1.
3. **Code signing of `install.ps1`** — Authenticode cert ~$100/yr;
   eliminates SmartScreen warning. Worth doing once user count > 100.
4. **Reproducible builds** — `package-lock.json` covers npm side;
   PowerShell + Node binary paths are not reproducible. Acceptable for
   now since we don't ship a single bundled `.exe`.
5. **Chain_data mirror trust** — if we add a mirror for chain_data
   downloads, mirror operator learns our IP. Worth offering download
   via Tor as an option? Slow but private.
6. **Hidden-service descriptor enumeration protection** — Tor v3 by
   default; no action needed unless Tor deprecates v3 or vulnerability
   discovered.
7. **Local multi-user machines** — the per-process session token
   (`lib/security/session-token.js`) only stops attacks that arrive
   through a browser (cross-site requests, DNS rebinding). It is not
   authentication: any local process, under any Windows account on the
   machine, can connect to `127.0.0.1:7420`, send the headers the UI
   sends to `GET /api/session/token`, obtain the token and drive every
   API of a server that runs elevated. On a shared PC that is a path from
   a standard account to service control. Candidates: hand the token to
   the launching user only (a file under an ACL'd folder, or a one-time
   URL fragment on the browser launch) and refuse `/api/session/token`
   otherwise; or a transport Windows can authenticate (named pipe).
   **Undecided** — until then the app assumes a single-user machine.

---

## 10. How to report a vulnerability

See [SECURITY.md](../SECURITY.md) at the repo root. **Do not file a
public GitHub issue** for security vulnerabilities — use the contact
listed in SECURITY.md.
