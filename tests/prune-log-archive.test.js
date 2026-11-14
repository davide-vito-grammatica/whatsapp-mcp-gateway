const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pruneArchive } = require('../scripts/maintenance/prune-log-archive');

test('removes old entries, preserves recent and unknown entries without modifying input', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-prune-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'in.gz'), output = path.join(dir, 'out.gz');
    const text = ['{"time":"2026-10-01T00:00:00.000Z","msg":"old"}',
        '{"time":"2026-11-10T00:00:00.000Z","msg":"new"}', 'unknown line'].join('\n') + '\n';
    const original = zlib.gzipSync(text); await fs.writeFile(input, original);
    const result = await pruneArchive(input, output, Date.parse('2026-11-01T00:00:00Z'));
    assert.deepEqual(result, { kept: 1, removed: 1, unknown: 1 });
    const contents = zlib.gunzipSync(await fs.readFile(output)).toString();
    assert.doesNotMatch(contents, /old/); assert.match(contents, /new/); assert.match(contents, /unknown line/);
    assert.deepEqual(await fs.readFile(input), original);
});
test('invalid or damaged archives never replace source', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-prune-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'in.gz'), output = path.join(dir, 'out.gz');
    await fs.writeFile(input, 'broken');
    await assert.rejects(pruneArchive(input, output, Date.now()));
    assert.equal(await fs.readFile(input, 'utf8'), 'broken');
});


test('filters an uncompressed rotated file into gzip without modifying it', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-prune-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'in.log'), output = path.join(dir, 'out.gz');
    const text = '{"time":"2026-10-01T00:00:00Z"}\n{"time":"2026-11-10T00:00:00Z"}\n';
    await fs.writeFile(input, text);
    const result = await pruneArchive(input, output, Date.parse('2026-11-01T00:00:00Z'), { compressed: false });
    assert.deepEqual(result, { kept: 1, removed: 1, unknown: 0 });
    assert.equal(await fs.readFile(input, 'utf8'), text);
    assert.match(zlib.gunzipSync(await fs.readFile(output)).toString(), /2026-11-10/);
});
