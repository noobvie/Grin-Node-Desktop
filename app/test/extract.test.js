'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const zlib   = require('node:zlib');

require('./helpers/tmp-root')('gnd-extract-');

const { extract } = require('../lib/util/extract');

// ── Hand-written archive builders (stored zip, ustar) ───────────────────────
// Real zip/tar tools refuse to write a `../` entry, which is exactly the
// entry the zip-slip guards must refuse to read.

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        let c = (crc ^ buf[i]) & 0xFF;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** @param {{name: string, data?: Buffer}[]} entries  name ending in "/" is a directory */
function makeZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const body    = data || Buffer.alloc(0);
        const crc     = crc32(body);

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);

        locals.push(lh, nameBuf, body);
        centrals.push(ch, nameBuf);
        offset += lh.length + nameBuf.length + body.length;
    }
    const cd   = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

function tarHeader(name, size) {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
}

function makeTarGz(entries) {
    const parts = [];
    for (const { name, data } of entries) {
        parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts));
}

// ── Tests ───────────────────────────────────────────────────────────────────

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grin-extract-test-')); });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture(name, buf) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, buf);
    return p;
}

test('a valid zip extracts files and directories under dest', async () => {
    const archive = fixture('ok.zip', makeZip([
        { name: 'win64/' },
        { name: 'win64/nssm.exe', data: Buffer.from('MZ fake binary') },
        { name: 'README.txt',     data: Buffer.from('hello') },
    ]));
    const dest = path.join(tmp, 'ok-zip');
    const r = await extract({ archive, dest, label: 'ok.zip' });

    assert.equal(r.files, 2);
    assert.equal(r.bytes, 'MZ fake binary'.length + 'hello'.length);
    assert.equal(fs.readFileSync(path.join(dest, 'win64', 'nssm.exe'), 'utf8'), 'MZ fake binary');
    assert.equal(fs.readFileSync(path.join(dest, 'README.txt'), 'utf8'), 'hello');
});

test('zip with a ../ entry is refused and nothing escapes dest', async () => {
    const archive = fixture('slip.zip', makeZip([
        { name: 'fine.txt',    data: Buffer.from('ok') },
        { name: '../evil.txt', data: Buffer.from('pwned') },
    ]));
    const dest = path.join(tmp, 'slip-zip', 'inner');
    await assert.rejects(extract({ archive, dest, label: 'slip.zip' }), /evil\.txt|relative path|\.\./);
    assert.ok(!fs.existsSync(path.join(tmp, 'slip-zip', 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
    // The handle is closed: the archive can be deleted at once on Windows.
    fs.unlinkSync(archive);
});

test('a corrupt zip rejects once without leaving a handle open', async () => {
    const archive = fixture('corrupt.zip', Buffer.from('this is not a zip file at all'));
    await assert.rejects(extract({ archive, dest: path.join(tmp, 'corrupt-zip') }));
    fs.unlinkSync(archive);
});

test('a valid tar.gz extracts under dest', async () => {
    const archive = fixture('ok.tar.gz', makeTarGz([
        { name: 'tor/tor.exe',   data: Buffer.from('MZ tor') },
        { name: 'tor/geoip',     data: Buffer.from('1.2.3.4 US') },
    ]));
    const dest = path.join(tmp, 'ok-tgz');
    const r = await extract({ archive, dest });
    assert.equal(r.files, 2);
    assert.equal(fs.readFileSync(path.join(dest, 'tor', 'tor.exe'), 'utf8'), 'MZ tor');
});

test('tar.gz with a ../ entry is refused and nothing escapes dest', async () => {
    const archive = fixture('slip.tar.gz', makeTarGz([
        { name: '../evil.txt', data: Buffer.from('pwned') },
    ]));
    const dest = path.join(tmp, 'slip-tgz', 'inner');
    fs.mkdirSync(dest, { recursive: true });
    await assert.rejects(extract({ archive, dest }));
    assert.ok(!fs.existsSync(path.join(tmp, 'slip-tgz', 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
});

test('unknown extension is rejected with a clear message', async () => {
    const archive = fixture('x.rar', Buffer.alloc(4));
    await assert.rejects(extract({ archive, dest: path.join(tmp, 'rar') }), /cannot infer format/);
});

// ── filter: an allow-list whose first rejection fails the extraction ────────

const onlyUnder = dir => (p) => p === dir || p === `${dir}/` || p.startsWith(`${dir}/`);

test('tar.gz filter: a rejected entry fails the extraction and is not written, nor is anything after it', async () => {
    const archive = fixture('filter.tar.gz', makeTarGz([
        { name: 'chain_data/a.mdb', data: Buffer.from('a') },
        { name: 'grin.exe',         data: Buffer.from('MZ evil') },
        { name: 'chain_data/b.mdb', data: Buffer.from('b') },
    ]));
    const dest = path.join(tmp, 'filter-tgz');
    await assert.rejects(
        extract({ archive, dest, filter: onlyUnder('chain_data') }),
        /entry refused by filter — File "grin\.exe"/);
    assert.equal(fs.existsSync(path.join(dest, 'grin.exe')), false);
    assert.equal(fs.existsSync(path.join(dest, 'chain_data', 'b.mdb')), false, 'nothing is written after the violation');
});

test('tar.gz filter: sees tar entry types and passes a clean archive', async () => {
    const archive = fixture('filter-ok.tar.gz', makeTarGz([
        { name: 'chain_data/a.mdb', data: Buffer.from('a') },
        { name: 'chain_data/b.mdb', data: Buffer.from('bb') },
    ]));
    const seen = [];
    const dest = path.join(tmp, 'filter-ok-tgz');
    const r = await extract({ archive, dest, filter: (p, type) => { seen.push([p, type]); return true; } });
    assert.equal(r.files, 2);
    assert.deepEqual(seen, [['chain_data/a.mdb', 'File'], ['chain_data/b.mdb', 'File']]);
    assert.equal(fs.readFileSync(path.join(dest, 'chain_data', 'b.mdb'), 'utf8'), 'bb');
});

test('zip filter: a rejected entry fails the extraction, is not written, and the handle is closed', async () => {
    const archive = fixture('filter.zip', makeZip([
        { name: 'win64/' },
        { name: 'win64/nssm.exe', data: Buffer.from('MZ') },
        { name: 'autorun.inf',    data: Buffer.from('[autorun]') },
        { name: 'win64/later.txt', data: Buffer.from('later') },
    ]));
    const seen = [];
    const dest = path.join(tmp, 'filter-zip');
    await assert.rejects(
        extract({ archive, dest, filter: (p, type) => { seen.push([p, type]); return onlyUnder('win64')(p); } }),
        /entry refused by filter — File "autorun\.inf"/);
    assert.deepEqual(seen, [['win64/', 'Directory'], ['win64/nssm.exe', 'File'], ['autorun.inf', 'File']]);
    assert.equal(fs.existsSync(path.join(dest, 'autorun.inf')), false);
    assert.equal(fs.existsSync(path.join(dest, 'win64', 'later.txt')), false);
    fs.unlinkSync(archive);
});

test('filter must be a function', async () => {
    const archive = fixture('nf.zip', makeZip([{ name: 'a.txt', data: Buffer.from('a') }]));
    await assert.rejects(extract({ archive, dest: path.join(tmp, 'nf'), filter: 'chain_data' }), /filter must be a function/);
});
