'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('node:os');
const disk   = require('../lib/util/disk');

test('freeBytes reports a positive number for the temp volume', async () => {
    const free = await disk.freeBytes(os.tmpdir());
    assert.equal(typeof free, 'number');
    assert.ok(free > 0, `expected > 0, got ${free}`);
    assert.ok(Number.isFinite(free));
});

test('freeBytes rejects for a path that does not exist', async () => {
    await assert.rejects(disk.freeBytes(require('node:path').join(os.tmpdir(), 'no-such-dir-4c1e9', 'x')));
});

test('requireFree passes when enough space is available', async () => {
    await disk.requireFree(os.tmpdir(), 1, 'tiny');
});

test('requireFree throws naming the label and GiB figures with one decimal', async () => {
    const absurd = 2 ** 60;                                     // 1 EiB — no laptop has it
    await assert.rejects(disk.requireFree(os.tmpdir(), absurd, 'chain data'), (e) => {
        assert.match(e.message, /^chain data: needs /);
        assert.match(e.message, /needs 1073741824\.0 GiB free/);
        assert.match(e.message, /only \d+\.\d GiB available/);
        return true;
    });
});
