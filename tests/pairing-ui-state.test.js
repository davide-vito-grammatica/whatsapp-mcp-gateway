const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function page(data) {
    const elements = new Map();
    const el = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false,
            disabled: false, dataset: {}, setAttribute() {}, getAttribute: () => '' });
        return elements.get(id);
    };
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, method: options?.method || 'GET' });
        return { ok: true, json: async () => data, text: async () => '' };
    };
    vm.runInNewContext(fs.readFileSync('src/server/public/link.js', 'utf8'), {
        document: { getElementById: el, hidden: false, addEventListener() {} },
        fetch, AbortSignal, DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
        setInterval() {}, navigator: {}, Date, String
    });
    await new Promise(resolve => setImmediate(resolve));
    el('admin-token').value = 'test-token';
    return { el, calls };
}

test('UI explains retained credentials and offers non-destructive reconnect', async () => {
    const { el } = await page({ connection: 'close', state: 'interrupted', registered: true,
        canRequest: false, canReconnect: true, unavailableReason: 'credentials_retained', code: null });
    el('code-tab').onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el('generate').disabled, true);
    assert.equal(el('reconnect').hidden, false);
    assert.match(el('status').textContent, /Credenziali conservate/);
});

test('QR mode shows automatic recovery and does not request pairing or manual reconnect', async () => {
    const { el, calls } = await page({ connection: 'close', state: 'interrupted', canReconnect: true,
        recovery: { state: 'scheduled', nextAttemptAt: Date.now() + 300000 },
        canRequest: false, unavailableReason: 'credentials_retained' });
    el('qr-tab').onclick(); await new Promise(resolve => setImmediate(resolve));
    assert.match(el('status').textContent, /Riconnessione automatica/);
    assert.equal(el('reconnect').hidden, true);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('QR mode explains a rejected session and offers an explicit reconnect in the same view', async () => {
    const { el, calls } = await page({ connection: 'close', state: 'interrupted', canReconnect: true,
        recovery: { state: 'blocked', reason: 'session_rejected' },
        canRequest: false, unavailableReason: 'credentials_retained' });
    el('qr-tab').onclick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(el('qr-panel').hidden, false);
    assert.equal(el('reconnect').hidden, false);
    assert.match(el('status').textContent, /rifiutata da WhatsApp/);
    assert.ok(calls.every(call => call.method === 'GET'));
    await el('reconnect').onclick();
    assert.equal(calls.filter(call => call.url.endsWith('/reconnect') && call.method === 'POST').length, 1);
});
