'use strict';
/**
 * Pinned download sources for the four binaries. Data only.
 *
 * TOR and NSSM are pinned to an exact URL + SHA256 because neither project
 * publishes releases through the GitHub API; the hash is the only thing that
 * ties the file we install to the file that was reviewed. Bump by editing
 * this file after re-computing the hash — never by widening the match.
 *
 * GRIN and GRIN_WALLET are resolved at install time through
 * installer/github.js; their checksum comes from the release's own
 * `-sha256sum.txt` asset, so nothing is pinned here but the repo and the
 * asset name pattern.
 */

const TOR = {
    // Tor Expert Bundle shipped with Tor Browser 15.0.26 (the newest stable
    // 15.x folder on archive.torproject.org). Hash computed 2026-11-09 from a
    // fresh download of this URL (22 507 599 bytes) with sha256sum.
    version:  '15.0.26',
    url:      'https://archive.torproject.org/tor-package-archive/torbrowser/15.0.26/tor-expert-bundle-windows-x86_64-15.0.26.tar.gz',
    sha256:   'c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252',
    // Archive layout: tor/tor.exe + its DLLs and pluggable_transports/, plus
    // data/ (geoip) and docs/. The whole tor/ folder is installed as a unit.
    innerExe: 'tor/tor.exe',
};

const NSSM = {
    // The pre-release build nssm.cc/download tells "Windows 10 Creators
    // Update or newer" to use: under release 2.24 a service can fail to
    // start there. Hash computed 2026-11-11 from a fresh download of this
    // URL (415 458 bytes) with sha256sum. The zip also holds a win32 build;
    // innerExe is matched as a full path so the 64-bit one is installed.
    version:  '2.24-101-g897c7ad',
    url:      'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip',
    sha256:   '99f5045fffbffb745d67fe3a065a953c4a3d9c253b868892d9b685b0ee7d07b8',
    innerExe: 'nssm-2.24-101-g897c7ad/win64/nssm.exe',
};

const GRIN = {
    owner:      'mimblewimble',
    repo:       'grin',
    assetRegex: /win-x86_64\.zip$/i,
    exeName:    'grin.exe',
};

const GRIN_WALLET = {
    owner:      'mimblewimble',
    repo:       'grin-wallet',
    assetRegex: /win-x86_64\.zip$/i,
    exeName:    'grin-wallet.exe',
};

module.exports = { TOR, NSSM, GRIN, GRIN_WALLET };
