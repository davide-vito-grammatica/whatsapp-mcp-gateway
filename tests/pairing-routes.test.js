const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const routes = require('../src/server/pairing-routes');
const { PairingService } = require('../src/services/pairing-service');
const token = 'test-only-admin-' + 'x'.repeat(40);
async function fixture(t, secret = token) {
    const pairing = new PairingService(); let calls = 0;
    pairing.attach({ authState: { creds: {} }, requestPairingCode: async () => { calls++; return 'MOCKCODE'; } });
    pairing.update({ qr: 'mock-qr' });
    const app = express(); app.use('/admin/pairing', routes({ pairing }, secret));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { pairing, calls: () => calls, url: `http://127.0.0.1:${server.address().port}/admin/pairing`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}
test('admin GET and POST deny absent/wrong/MCP tokens and query-string tokens', async t => {
    const { url, calls } = await fixture(t);
    for (const method of ['GET', 'POST']) for (const auth of ['', 'Bearer wrong-mcp-token']) {
        const response = await fetch(url + (method === 'GET' ? '/status' : '/code') + '?token=' + token,
            { method, headers: { Authorization: auth } });
        assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(!(await response.text()).includes('MOCKCODE'));
    }
    assert.equal(calls(), 0);
});
test('missing admin configuration fails closed', async t => {
    const { url, headers } = await fixture(t, '');
    assert.equal((await fetch(url + '/status', { headers })).status, 503);
});
test('authenticated request/status returns code only under admin router; repeat blocked', async t => {
    const { url, headers, calls } = await fixture(t);
    const response = await fetch(url + '/code', { method: 'POST', headers, body: JSON.stringify({ phoneNumber: '12025550100' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).code, 'MOCKCODE');
    assert.equal((await (await fetch(url + '/status', { headers })).json()).code, 'MOCKCODE');
    const repeat = await fetch(url + '/code', { method: 'POST', headers, body: JSON.stringify({ phoneNumber: '12025550100' }) });
    assert.equal(repeat.status, 409); assert.equal(calls(), 1);
});
test('JSON required and failed native request yields sanitized error and Retry-After', async t => {
    const { pairing, url, headers } = await fixture(t);
    const noJson = await fetch(url + '/code', { method: 'POST', headers: { Authorization: headers.Authorization }, body: 'phoneNumber=12025550100' });
    assert.equal(noJson.status, 415);
    pairing.sock.requestPairingCode = async () => { throw Error('PRIVATE'); };
    const options = { method: 'POST', headers, body: JSON.stringify({ phoneNumber: '12025550100' }) };
    assert.deepEqual(await (await fetch(url + '/code', options)).json(), { error: 'pairing_request_failed' });
    const limited = await fetch(url + '/code', options);
    assert.equal(limited.status, 429); assert.ok(limited.headers.has('retry-after'));
});

test('malformed/oversized admin JSON is sanitized after authentication', async t => {
    const { url, headers, calls } = await fixture(t);
    const unauthorized = await fetch(url + '/code', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{PRIVATE' });
    assert.equal(unauthorized.status, 401);
    const malformed = await fetch(url + '/code', { method: 'POST', headers, body: '{PRIVATE' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
    const oversized = await fetch(url + '/code', { method: 'POST', headers,
        body: JSON.stringify({ phoneNumber: 'PRIVATE'.repeat(500) }) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'pairing_payload_too_large' });
    assert.equal(calls(), 0);
});

test('manual reconnect endpoint is protected and sanitized', async t => {
    const { url, headers, calls } = await fixture(t);
    assert.equal((await fetch(url + '/reconnect', { method: 'POST' })).status, 401);
    // Fixture deliberately lacks reconnect; internal details must not escape.
    const failed = await fetch(url + '/reconnect', { method: 'POST', headers, body: '{}' });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'pairing_reconnect_failed' });
    assert.equal(calls(), 0);
});
