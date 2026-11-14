const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Outbox = require('../src/services/outbox');
async function fixture(t, options = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outbox-test-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    return new Outbox({ baseDir: dir, ...options, mediaOptions: { allowedHosts: ['example.test'], lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], ...options.mediaOptions } });
}
test('disconnect pauses; reconnect sends persisted media without redownloading', async t => {
    const q = await fixture(t), image = Buffer.from('synthetic');
    const record = await q.enqueue({ to: '12025550100', message: 'test', imageBuffer: image });
    let calls = 0;
    await q.retryPending(async () => { calls++; }, { isConnected: () => false });
    assert.equal(calls, 0); assert.equal((await q.counts()).pending, 1);
    await q.retryPending(async p => { calls++; assert.deepEqual(p.imageBuffer, image); });
    assert.equal(calls, 1); assert.equal((await q.counts()).sent, 1);
    assert.equal(fs.existsSync(path.join(q.files, record.mediaFile)), false);
});
test('timeout isolates a hung send and does not replay an ambiguous outcome', async t => {
    const q = await fixture(t, { timeout: 15, concurrency: 2 });
    await q.enqueue({ message: 'slow' }); await q.enqueue({ message: 'fast' });
    let calls = 0;
    const send = async p => { calls++; if (p.message === 'slow') return new Promise(() => {}); };
    await q.retryPending(send); await q.retryPending(send);
    assert.equal(calls, 2); const counts = await q.counts();
    assert.equal(counts.unknown, 1); assert.equal(counts.sent, 1);
});
test('crashed sending record becomes unknown and is never replayed', async t => {
    const q = await fixture(t); const record = await q.enqueue({ message: 'test' });
    record.status = 'sending'; await q.write(record);
    let calls = 0; await q.retryPending(async () => { calls++; });
    assert.equal(calls, 0); assert.equal((await q.counts()).unknown, 1);
});
test('expires messages and prevents attempts beyond the configured cap', async t => {
    let now = 1000000; const q = await fixture(t, { clock: () => now, maxAttempts: 2, maxAge: 100 });
    const a = await q.enqueue({ message: 'old' }); now += 101;
    const b = await q.enqueue({ message: 'attempted' }); b.attempts = 2; await q.write(b);
    await q.retryPending(async () => { throw Error('must not send'); });
    const records = await q.records();
    assert.equal(records.find(r => r.id === a.id).lastError, 'expired');
    assert.equal(records.find(r => r.id === b.id).lastError, 'attempts_exhausted');
});
test('failure persisting sending state prevents external send', async t => {
    const q = await fixture(t); const record = await q.enqueue({ message: 'test' });
    q.write = async () => { throw Error('disk failure'); };
    let calls = 0; await assert.rejects(q.process(record, async () => { calls++; }, () => true));
    assert.equal(calls, 0); assert.equal(q.inflight, 0);
});
test('permanent deferred media error fails without sending or persisting URL in error', async t => {
    const q = await fixture(t, { mediaOptions: { fetchImpl: async () => ({ ok: false, status: 403 }) } });
    await q.enqueue({ message: 'test', imageUrl: 'https://example.test/img?token=SECRET' }, { mediaPolicy: 'deferred' });
    let calls = 0; await q.retryPending(async () => { calls++; });
    const record = (await q.records())[0];
    assert.equal(calls, 0); assert.equal(record.status, 'failed'); assert.equal(record.lastError, 'media_http_403');
    assert.ok(!JSON.stringify(await q.summaries()).includes('SECRET'));
});
test('optional deferred media can fall back to text', async t => {
    const q = await fixture(t, { mediaOptions: { fetchImpl: async () => ({ ok: false, status: 404 }) } });
    await q.enqueue({ message: 'text', imageUrl: 'https://example.test/a' }, { mediaPolicy: 'optional' });
    await q.retryPending(async payload => { assert.equal(payload.imageUrl, undefined); assert.equal(payload.message, 'text'); });
    assert.equal((await q.counts()).sent, 1);
});
test('attachment quota and permissions are enforced', async t => {
    const q = await fixture(t, { maxBytes: 3 });
    await assert.rejects(q.enqueue({ imageBuffer: Buffer.alloc(4) }), /outbox_capacity/);
    const r = await q.enqueue({ imageBuffer: Buffer.alloc(3) });
    assert.equal((await fs.promises.stat(q.dir)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(path.join(q.files, r.mediaFile))).mode & 0o777, 0o600);
});

test('deferred temporary media errors back off and terminate at max attempts', async t => {
    let now = 1000000, calls = 0;
    const q = await fixture(t, { clock: () => now, random: () => 0, maxAttempts: 2,
        mediaOptions: { fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } } });
    await q.enqueue({ message: 'test', imageUrl: 'https://example.test/a' }, { mediaPolicy: 'deferred' });
    await q.retryPending(async () => { throw Error('must not send'); });
    assert.equal((await q.counts()).pending, 1);
    await q.retryPending(async () => {}); assert.equal(calls, 1);
    now += 60000; await q.retryPending(async () => {});
    const record = (await q.records())[0]; assert.equal(record.status, 'failed'); assert.equal(record.attempts, 2); assert.equal(calls, 2);
});

test('media acquired on deferred retry survives until a later send', async t => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'); let connectedChecks = 0, downloads = 0;
    const q = await fixture(t, { mediaOptions: { fetchImpl: async () => { downloads++; return { ok: true,
        headers: new Headers({ 'content-type': 'image/png' }), body: (async function* () { yield png; })() }; } } });
    await q.enqueue({ message: 'test', imageUrl: 'https://example.test/expiring?token=SECRET' }, { mediaPolicy: 'deferred' });
    await q.retryPending(async () => { throw Error('must not send'); }, { isConnected: () => ++connectedChecks === 1 });
    const record = (await q.records())[0]; assert.equal(record.status, 'pending'); assert.equal(record.payload.imageUrl, undefined);
    await q.retryPending(async payload => { assert.deepEqual(payload.imageBuffer, png); });
    assert.equal(downloads, 1); assert.equal((await q.counts()).sent, 1);
});

test('isolated outbox never reads or modifies legacy pending records', async t => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outbox-legacy-test-'));
    t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
    const legacy = path.join(parent, 'dead-letter-queue'); await fs.promises.mkdir(legacy);
    const before = JSON.stringify({ status: 'pending', payload: { message: 'historical fixture' } });
    const file = path.join(legacy, 'legacy.json'); await fs.promises.writeFile(file, before);
    const q = new Outbox({ baseDir: path.join(parent, 'outbox-v2') });
    let calls = 0; await q.retryPending(async () => { calls++; });
    assert.equal(calls, 0); assert.equal(await fs.promises.readFile(file, 'utf8'), before);
});

test('optional deferred policy cannot bypass denied media targets', async t => {
    const q = await fixture(t, { mediaOptions: { allowedHosts: [] } });
    await q.enqueue({ message: 'text', imageUrl: 'https://blocked.example/a' }, { mediaPolicy: 'optional' });
    let sends = 0; await q.retryPending(async () => { sends++; });
    assert.equal(sends, 0); assert.equal((await q.counts()).failed, 1);
});
