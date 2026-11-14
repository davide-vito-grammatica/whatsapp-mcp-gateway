const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('express');
const { MediaError } = require('../src/services/media-download');
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { Authorization: 'Bearer ' + 'test-api-' + 'y'.repeat(40), ...options.headers } });
const filename = path.resolve('src/server/app.js'), local = createRequire(filename);
async function fixture(t, options = {}) {
    let calls = 0, payload, state = options.connected !== false;
    const client = { setConnectionRestoredHandler() {}, getStatus: () => ({ status: state ? 'connected' : 'disconnected' }),
        sendMessage: async (...args) => { calls++; payload = args; if (options.ambiguous) throw Error('https://private/?token=SECRET'); return { key: { id: 'mock' } }; } };
    let queued;
    class Queue { async enqueue(p) { queued = { ...p }; return { id: 'test-id' }; } }
    const app = express(), listen = app.listen.bind(app); app.listen = () => ({});
    const mocks = { express: Object.assign(() => app, express), '../client/baileys-client': client,
        '../services/outbox': Queue, '../services/media-download': { downloadMedia: options.download || (async () => ({ buffer: Buffer.from('synthetic') })) },
        '../config/config-loader': { getServerPort: () => 3000 }, '../config/swagger': {},
        '../utils/logger': { expressMiddleware: (req,res,next) => next(), log: new Proxy({}, { get: () => () => {} }) },
        './pairing-routes': () => express.Router() };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = app;', {
        module: { exports: {} }, require: n => mocks[n] || local(n), __dirname: path.dirname(filename),
        process: { env: { WHATSAPP_API_TOKEN: 'test-api-' + 'y'.repeat(40), WHATSAPP_ADMIN_TOKEN: 'test-only-' + 'x'.repeat(40) }, on() {} }, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), console: { log() {}, error() {} }, Buffer
    }, { filename });
    const server = listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { origin: `http://127.0.0.1:${server.address().port}`, calls: () => calls, payload: () => payload, queued: () => queued };
}
async function post(f, body) {
    const res = await fetch(f.origin + '/send-message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}
test('test-message requires an explicit recipient without sending or queueing', async t => {
    const f = await fixture(t);
    for (const query of ['', '?to=', '?to=%20']) {
        const res = await fetch(f.origin + '/test-message' + query);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).success, false);
    }
    assert.equal(f.calls(), 0);
    assert.equal(f.queued(), undefined);
});
test('test-message sends only to the explicitly supplied recipient', async t => {
    const f = await fixture(t);
    const res = await fetch(f.origin + '/test-message?to=390000000000&message=synthetic');
    assert.equal(res.status, 200);
    assert.equal(f.calls(), 1);
    assert.equal(f.payload()[0], '390000000000');
});
test('required 403 is rejected without queue or send and without token leak', async t => {
    const f = await fixture(t, { download: async () => { throw new MediaError('media_http_403', false, 403); } });
    const r = await post(f, { to: '12025550100', message: 'x', imageUrl: 'https://example.test/?token=SECRET' });
    assert.equal(r.status, 424); assert.equal(r.body.error, 'media_http_403'); assert.equal(f.calls(), 0); assert.equal(f.queued(), undefined);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('optional 404 sends text only and reports fallback', async t => {
    const f = await fixture(t, { download: async () => { throw new MediaError('media_http_404'); } });
    const r = await post(f, { to: '12025550100', message: 'x', imageUrl: 'https://example.test/a', mediaPolicy: 'optional' });
    assert.equal(r.status, 200); assert.equal(r.body.mediaFallback, true); assert.equal(r.body.messageType, 'text'); assert.equal(r.body.hasImage, false); assert.equal(f.payload()[2], null); assert.equal(f.payload()[3].imageBuffer, undefined);
});
test('disconnected request queues acquired image instead of expiring URL', async t => {
    const f = await fixture(t, { connected: false });
    const r = await post(f, { to: '12025550100', message: 'x', imageUrl: 'https://example.test/a?token=SECRET' });
    assert.equal(r.status, 202); assert.equal(r.body.mediaAcquired, true); assert.equal(f.calls(), 0);
    assert.equal(f.queued().imageUrl, null); assert.equal(f.queued().imageBuffer.toString(), 'synthetic');
});
test('ambiguous failure is not queued or retried', async t => {
    const f = await fixture(t, { ambiguous: true }); const r = await post(f, { to: '12025550100', message: 'x' });
    assert.equal(r.status, 502); assert.equal(r.body.delivery_status, 'unknown'); assert.equal(f.calls(), 1); assert.equal(f.queued(), undefined);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('deferred temporary failure queues without claiming acquisition', async t => {
    const f = await fixture(t, { download: async () => { throw new MediaError('media_timeout', true); } });
    const r = await post(f, { to: '12025550100', message: 'x', imageUrl: 'https://example.test/a', mediaPolicy: 'deferred' });
    assert.equal(r.status, 202); assert.equal(r.body.mediaAcquired, false); assert.equal(f.calls(), 0);
});

test('blocked media targets never trigger optional text fallback', async t => {
    const f = await fixture(t, { download: async () => { throw new MediaError('media_target_denied'); } });
    const r = await post(f, { to: '12025550100', message: 'x', imageUrl: 'https://blocked.example/a', mediaPolicy: 'optional' });
    assert.equal(r.status, 424); assert.equal(f.calls(), 0); assert.equal(f.queued(), undefined);
});
