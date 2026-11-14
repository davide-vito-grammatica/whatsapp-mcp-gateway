const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('express');
const { PairingService } = require('../src/services/pairing-service');
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { Authorization: 'Bearer ' + 'test-only-' + 'x'.repeat(40), ...options.headers } });
const filename = path.resolve('src/server/app.js');
const localRequire = createRequire(filename);

async function fixture(t) {
    const client = { pairing: new PairingService(), setConnectionRestoredHandler() {},
        getStatus: () => ({ status: 'connecting' }), getQRCode: () => 'mock-qr',
        getQRCodeImage: () => 'data:image/png;base64,bW9jaw==' };
    const app = express(); const listen = app.listen.bind(app); app.listen = () => ({});
    const mocks = {
        express: Object.assign(() => app, express),
        '../client/baileys-client': client,
        '../config/config-loader': { getServerPort: () => 3000 }, '../config/swagger': {},
        '../utils/logger': { expressMiddleware: (req, res, next) => next(), log: new Proxy({}, { get: () => () => {} }) },
        '../services/outbox': class {},
        './pairing-routes': c => localRequire('./pairing-routes')(c, 'test-only-' + 'x'.repeat(40))
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = app;', {
        module: { exports: {} }, require: name => mocks[name] || localRequire(name),
        __dirname: path.dirname(filename), process: { env: { WHATSAPP_API_TOKEN: 'test-api-' + 'y'.repeat(40), WHATSAPP_ADMIN_TOKEN: 'test-only-' + 'x'.repeat(40) }, on() {} }, setTimeout() {}, setInterval: () => ({ unref() {} }),
        console: { log() {} }
    }, { filename });
    const server = listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { client, origin: `http://127.0.0.1:${server.address().port}` };
}

test('existing QR endpoint keeps HTML/404 contract and adds mode selection', async t => {
    const { client, origin } = await fixture(t);
    const response = await fetch(origin + '/qr-code');
    assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /data:image\/png;base64,bW9jaw==/);
    assert.match(html, /Collega con QR code/); assert.match(html, /Collega con codice/);
    client.getStatus = () => ({ status: 'connected' });
    const unavailable = await fetch(origin + '/qr-code');
    assert.equal(unavailable.status, 404); assert.equal((await unavailable.json()).status, 'connected');
    assert.equal((await fetch(origin + '/session/link')).status, 200);
    const browser = await fetch(origin + '/qr-code', {
        headers: { Accept: 'text/html' }, redirect: 'manual'
    });
    assert.equal(browser.status, 303);
    assert.equal(browser.headers.get('location'), '/session/link');
});
test('authenticated status and public management HTML never include pairing code; admin routes deny access', async t => {
    const { client, origin } = await fixture(t);
    client.pairing.code = 'SECRETCODE'; client.pairing.expiresAt = Date.now() + 60000;
    for (const endpoint of ['/status', '/session/link', '/qr-code']) {
        const response = await fetch(origin + endpoint);
        assert.equal(response.status, 200); const body = await response.text();
        assert.ok(!body.includes('SECRETCODE'));
        if (endpoint === '/status') assert.ok(!body.includes('mock-qr'));
    }
    assert.equal((await fetch(origin + '/admin/pairing/status', { headers: { Authorization: '' } })).status, 401);
    const script = await fetch(origin + '/session/link.js');
    assert.equal(script.status, 200); assert.match(await script.text(), /clipboard.writeText/);
});


test('status exposes sanitized diagnostics and cooldown in minutes', async t => {
    const { client, origin } = await fixture(t);
    client.sessionResetCooldown = 300000;
    client.getStatus = () => ({ status: 'disconnected', diagnostic: { phase: 'error', lastError: 'socket_timeout' } });
    const data = await (await fetch(origin + '/status')).json();
    assert.equal(data.sessionConfig.resetCooldownMinutes, 5);
    assert.equal(data.diagnostic.lastError, 'socket_timeout');
});
