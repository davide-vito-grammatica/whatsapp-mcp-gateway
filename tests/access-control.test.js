const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { accessControl, routeLevel } = require('../src/server/access-control');
const api = 'synthetic-api-' + 'a'.repeat(40), admin = 'synthetic-admin-' + 'b'.repeat(40);
async function fixture(t, env = {}, clock = Date.now) {
    let calls = 0;
    const app = express(); app.use(accessControl({ WHATSAPP_API_TOKEN: api, WHATSAPP_ADMIN_TOKEN: admin, ...env }, clock));
    app.use(express.json({ limit: '1kb' }));
    app.use((req, res) => { calls++; res.json({ success: true }); });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
    return { origin: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}
const headers = token => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
test('all sensitive API paths deny missing, wrong and query-string credentials before JSON parsing', async t => {
    const f = await fixture(t);
    for (const path of ['/send-message', '/send-message-upload', '/session/logout', '/session/reset', '/session/reset-crypto', '/session/clean-auth', '/dead-letter-queue/retry', '/groups/refresh', '/keepalive/send-now', '/admin/pairing/code']) {
        for (const auth of ['', 'Bearer wrong']) {
            const r = await fetch(f.origin + path + '?token=' + admin, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: '{SENSITIVE' });
            assert.equal(r.status, 401, path); assert.ok(!(await r.text()).includes('SENSITIVE'));
        }
    }
    assert.equal(f.calls(), 0);
});
test('API token cannot administer, see QR, or inspect queued payloads; admin can', async t => {
    const f = await fixture(t);
    for (const [path, method] of [['/qr-code','GET'], ['/dead-letter-queue','GET'], ['/session/reset','POST'], ['/groups/123/ephemeral','POST'], ['/keepalive/reload-config','POST']]) {
        assert.equal((await fetch(f.origin + path, { method, headers: headers(api) })).status, 401);
        assert.equal((await fetch(f.origin + path, { method, headers: headers(admin) })).status, 200);
    }
    assert.equal((await fetch(f.origin + '/status', { headers: headers(api) })).status, 200);
    assert.equal((await fetch(f.origin + '/status')).status, 401);
});
test('absent or duplicate tokens fail closed, static management and health remain accessible', async t => {
    for (const env of [{ WHATSAPP_API_TOKEN: '' }, { WHATSAPP_API_TOKEN: admin }]) {
        const f = await fixture(t, env);
        assert.equal((await fetch(f.origin + '/status', { headers: headers(admin) })).status, 503);
        for (const path of ['/health', '/session/link', '/session/link.js', '/api-docs', '/api-docs.json', '/api-docs/swagger-ui.css']) assert.equal((await fetch(f.origin + path)).status, 200);
    }
    assert.equal(routeLevel('/session/link/private', 'GET'), 'admin');
    assert.equal(routeLevel('/session/link', 'POST'), 'admin');
});
test('cross-origin requests are denied unless explicitly configured; preflight does not invoke handlers', async t => {
    const f = await fixture(t, { WHATSAPP_ALLOWED_ORIGINS: 'https://trusted.example' });
    assert.equal((await fetch(f.origin + '/send-message', { method: 'POST', headers: { ...headers(api), Origin: 'https://evil.example' } })).status, 403);
    const r = await fetch(f.origin + '/send-message', { method: 'OPTIONS', headers: { Origin: 'https://trusted.example' } });
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://trusted.example');
    assert.equal(f.calls(), 0);
});
test('failed auth is rate limited using the socket peer, ignoring spoofed forwarded IPs', async t => {
    let clock = 0; const f = await fixture(t, { API_REQUESTS_PER_MINUTE: '10' }, () => clock);
    for (let i = 0; i < 10; i++) assert.equal((await fetch(f.origin + '/status', { headers: { 'X-Forwarded-For': `203.0.113.${i}` } })).status, 401);
    const r = await fetch(f.origin + '/status'); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
    clock = 60001; assert.equal((await fetch(f.origin + '/status', { headers: headers(api) })).status, 200);
});

test('HEAD liveness and static documentation work without credentials; writes remain protected', async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.origin + '/health', { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(f.origin + '/api-docs')).status, 200);
    assert.equal((await fetch(f.origin + '/api-docs.json')).status, 200);
    assert.equal((await fetch(f.origin + '/api-docs', { method: 'POST' })).status, 401);
    assert.equal((await fetch(f.origin + '/api-docs-evil')).status, 401);
});
