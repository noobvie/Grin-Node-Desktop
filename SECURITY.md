# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

If you find a security issue in Grin Money Desktop — anything that
could let an attacker access wallets, intercept transactions, leak
secrets, or otherwise compromise users — report it privately first.

### How to report

Send a report to **`security@grin.money`** with:

- A description of the issue
- Steps to reproduce (or proof of concept)
- The impact you think it has (who can do what)
- Your name / handle if you'd like credit (optional)

If you want to encrypt the report, a PGP key will be published once
this project has its first public release. Until then, use TLS-only
email and keep the report concise.

### What to expect

| Step | Timeline |
|---|---|
| Acknowledgement of your report | Within **72 hours** |
| Initial triage + severity assessment | Within **7 days** |
| Coordinated disclosure window | **90 days** from acknowledgement (longer if the fix requires upstream Grin changes) |
| Public credit (if you want it) | In the release notes that ship the fix |

If you don't hear back within 72 hours, please re-send — the email may
have been filtered. Repeat after 7 more days. After that, if there's
still no response, you're free to disclose publicly; this project
takes the risk of slow response on itself, not on you.

### What's in scope

- The code in this repository (`install.ps1`, `scripts/`, `app/`)
- The deployment of `install.ps1` at `https://grin.money/install`
- Documentation that materially affects security (e.g. wrong recovery
  instructions that could lose users' funds)

### What's NOT in scope (report upstream)

- Vulnerabilities in **`grin.exe`** itself — report to
  <https://github.com/mimblewimble/grin/security>
- Vulnerabilities in **`grin-wallet.exe`** — report to
  <https://github.com/mimblewimble/grin-wallet/security>
- Vulnerabilities in **Tor** — report via <https://blog.torproject.org/sec>
- Vulnerabilities in **NSSM** — see <https://nssm.cc>
- Vulnerabilities in **Node.js**, **npm packages**, or **Windows**
  itself — report to the respective maintainers
- **Social engineering** of users (phishing sites, fake support, etc.)
  — we'll publicize warnings but can't fix users' opsec for them

We will **forward upstream reports** if you send them to us by mistake,
but the upstream channel is faster.

### What's explicitly NOT a vulnerability

Things people sometimes report that aren't bugs:

- **"Someone with physical access to my unlocked computer could send
  my coins."** Correct — see [security-model.md §3](planning/security-model.md#3-what-this-wallet-does-not-protect-against).
- **"A keylogger could steal my passphrase."** Correct, and out of
  scope. This wallet does not defend against malware already running
  on the machine.
- **"The wallet UI is reachable from `127.0.0.1` without authentication."**
  By design for v1. Any process running as the same Windows user can
  already access the wallet's files; localhost UI auth wouldn't help.
- **"There's no rate limiting on the local API."** It's localhost-only.
  An attacker who can hit localhost can already do worse.

For grey-area cases — when you think something is a bug but the above
list applies — please report it anyway and let us decide. We'd rather
read a few clear "by-design" reports than miss a real one.

---

## Verifying releases

Once we ship signed releases, this section will document the
Authenticode signature you should expect, and how to verify it.

Until then:
- Verify the source URL of `install.ps1` is exactly
  `https://grin.money/install` (not a typo'd lookalike).
- The script's first line must be `#Requires -Version 5.1` — if it
  isn't, the file is wrong; abort.
- Cross-check binary SHA256s against what's recorded in
  `app/state/binaries.json` after install — those values are written
  by `app/lib/installer/binaries.js` and never touch the network during
  recording.

---

## Hall of fame

People who have responsibly disclosed issues will be listed here once
there are any to acknowledge. Their work makes the wallet safer for
everyone — thank you in advance.

*(empty for now)*

---

## See also

- [planning/security-model.md](planning/security-model.md) — the full
  threat model: trust boundaries, threats considered, threats out of
  scope, code-level rules for contributors.
- [planning/architecture.md §13](planning/architecture.md#13-scope--what-we-dont-build)
  — what features are explicitly *not* in the project's scope.
