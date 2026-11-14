const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const baileys = require('@whiskeysockets/baileys');
const filename = path.resolve('src/client/baileys-client.js');
const localRequire = createRequire(filename);

async function fixture(t, existingAuthDir, versionMocks = {}) {
    const authDir = existingAuthDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pairing-auth-test-'));
    t.after(() => fs.promises.rm(authDir, { recursive: true, force: true }));
    const sockets = [], timers = [], qrCalls = [], savedPaths = [], versionRequests = [];
    const noop = () => {};
    const monitor = class { updateConnectionStatus() {} start() {} stop() {} };
    const mocks = {
        '@whiskeysockets/baileys': { ...baileys,
            useMultiFileAuthState: async suppliedPath => { savedPaths.push(suppliedPath); return versionMocks.auth ? versionMocks.auth(authDir) : baileys.useMultiFileAuthState(authDir); },
            fetchLatestWaWebVersion: versionMocks.web || (async options => {
                versionRequests.push(['web', options.timeout]);
                return { version: [2, 3000, 1], isLatest: true };
            }),
            fetchLatestBaileysVersion: async options => {
                versionRequests.push(['baileys', options.timeout]);
                return { version: [2, 3000, 0], isLatest: true };
            },
            default: options => {
                const sock = { ev: new EventEmitter(), ws: new EventEmitter(), authState: options.auth, version: options.version, browser: options.browser,
                    requestPairingCode: async () => 'MOCKCODE', end: noop, logout: noop };
                sockets.push(sock); return sock;
            } },
        'qrcode-terminal': { generate: value => qrCalls.push(value) },
        qrcode: { toDataURL: versionMocks.qr || (async () => 'data:image/png;base64,bW9jaw==') },
        '../utils/logger': { log: new Proxy({}, { get: () => noop }), baileysLogger: {} },
        '../utils/email-notifier': monitor,
        '../utils/connection-monitor': monitor,
        // Read no real configuration or credentials.
        fs: { ...fs, existsSync: () => false }
    };
    const context = { require: name => mocks[name] || localRequire(name), module: { exports: {} },
        __dirname: path.dirname(filename), console: { log: noop, warn: noop, error: noop },
        setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
        clearTimeout: timer => { if (timer) timer.cancelled = true; }, setInterval: noop, clearInterval: noop, setImmediate: noop,
        process: { env: {} }, Buffer, URL };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const client = context.module.exports;
    client.startKeepAlive = noop; client.stopKeepAlive = noop;
    const update = async value => {
        const sock = sockets.at(-1);
        for (const handler of sock.ev.listeners('connection.update')) await handler(value);
    };
    return { client, sockets, timers, qrCalls, authDir, savedPaths, update, versionRequests };
}

test('QR remains available and a partial update does not erase it', async t => {
    const { client, update, qrCalls } = await fixture(t);
    await client.connect();
    await update({ connection: 'connecting' }); await update({ qr: 'mock-qr' });
    assert.equal(client.getQRCode(), 'mock-qr');
    assert.match(client.getQRCodeImage(), /^data:image\/png;base64,/);
    await update({ receivedPendingNotifications: false });
    assert.equal(client.getQRCode(), 'mock-qr'); assert.deepEqual(qrCalls, ['mock-qr']);
    assert.equal(client.pairing.status().canRequest, true);
});

test('515 flushes real multi-file credentials then reconnects; a fresh client restores them', async t => {
    const f = await fixture(t);
    await f.client.connect(); await f.update({ connection: 'connecting', qr: 'mock-qr' });
    await f.client.pairing.request('12025550100');
    const sock = f.sockets[0];
    sock.authState.creds.registered = true;
    sock.ev.emit('creds.update', { registered: true });
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    const restart = f.timers.find(timer => timer.delay === 0 && !timer.cancelled);
    assert.ok(restart); await restart.fn();
    assert.equal(f.sockets.length, 2);
    assert.equal(f.sockets[1].authState.creds.registered, true);
    await f.update({ connection: 'open' });
    assert.equal(f.client.getStatus().status, 'connected');
    assert.equal(f.client.pairing.status().code, null);
    await assert.rejects(f.client.pairing.request('12025550100'), /session_already_registered/);
    const restored = await baileys.useMultiFileAuthState(f.authDir);
    assert.equal(restored.state.creds.registered, true);
    assert.ok(f.savedPaths.every(value => value.endsWith('/data/auth')));
    // A fresh instance (process restart) uses the same existing auth helper.
    const fresh = await fixture(t, f.authDir);
    // The on-disk roundtrip above uses the real Baileys serializer, no network.
    await fresh.client.connect();
    assert.equal(fresh.sockets.length, 1);
    assert.equal(fresh.sockets[0].authState.creds.registered, true);
    await assert.rejects(fresh.client.pairing.request('12025550100'), /session_already_registered/);
});

test('transport closures retry without deleting credentials; logged out preserves files', async t => {
    const f = await fixture(t);
    await f.client.connect();
    f.sockets[0].authState.creds.registered = true;
    f.sockets[0].ev.emit('creds.update', {});
    await f.client.credentialWrites;
    const before = await fs.promises.readFile(path.join(f.authDir, 'creds.json'));
    f.client.cleanCorruptedAuthFiles = () => { throw Error('must not delete'); };
    await f.update({ connection: 'close', lastDisconnect: { error: new Error('Connection Failure') } });
    const retry = f.timers.find(timer => !timer.cancelled); assert.ok(retry); await retry.fn();
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.deepEqual(await fs.promises.readFile(path.join(f.authDir, 'creds.json')), before);
    assert.equal(f.client.pairing.status().registered, true);
});

test('concurrent connect uses one socket; explicit soft disconnect does not schedule reconnect', async t => {
    const f = await fixture(t);
    await Promise.all([f.client.connect(), f.client.connect()]);
    assert.equal(f.sockets.length, 1);
    const socket = f.sockets[0];
    socket.end = () => socket.ev.emit('connection.update', { connection: 'close' });
    await f.client.disconnect();
    assert.equal(f.client.sock, null); assert.equal(f.client.pairing.sock, null);
    assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
});

test('incomplete native pairing restarts registration without changing persisted credentials on startup', async t => {
    const f = await fixture(t);
    const auth = await baileys.useMultiFileAuthState(f.authDir);
    Object.assign(auth.state.creds, { registered: false, pairingCode: 'MOCKCODE', me: { id: '12025550100@s.whatsapp.net' } });
    await auth.saveCreds();
    const before = await fs.promises.readFile(path.join(f.authDir, 'creds.json'));
    await f.client.connect();
    assert.equal(f.sockets[0].authState.creds.me, undefined);
    assert.deepEqual(await fs.promises.readFile(path.join(f.authDir, 'creds.json')), before);
    f.sockets[0].authState.creds.registered = true;
    f.sockets[0].authState.creds.me = { id: '12025550100:1@s.whatsapp.net' };
    f.sockets[0].ev.emit('creds.update', {}); await f.client.credentialWrites;
    const restored = await baileys.useMultiFileAuthState(f.authDir);
    assert.equal(restored.state.creds.registered, true);
    assert.equal(restored.state.creds.me.id, '12025550100:1@s.whatsapp.net');
});
test('manual reconnect after terminal close shares one socket and preserves auth files', async t => {
    const f = await fixture(t);
    await f.client.connect();
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(f.client.pairing.status().canReconnect, true);
    await Promise.all([f.client.reconnectForPairing(), f.client.reconnectForPairing()]);
    assert.equal(f.sockets.length, 2);
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await assert.rejects(f.client.reconnectForPairing(), /pairing_rate_limited/);
});
test('manual reconnect retries retained registered credentials without deleting them', async t => {
    const f = await fixture(t); await f.client.connect();
    f.sockets[0].authState.creds.registered = true;
    f.sockets[0].ev.emit('creds.update'); await f.client.credentialWrites;
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(f.client.pairing.status().canReconnect, true);
    await f.client.reconnectForPairing();
    assert.equal(f.sockets.length, 2);
    assert.equal(f.client.pairing.status().registered, true);
});

test('unregistered code pairing uses the native Windows/Chrome profile; authenticated sessions retain their profile', async t => {
    const f = await fixture(t); await f.client.connect();
    assert.deepEqual(Array.from(f.sockets[0].browser), baileys.Browsers.windows('Chrome'));
    assert.equal(`${f.sockets[0].browser[1]} (${f.sockets[0].browser[0]})`, 'Chrome (Windows)');
    f.sockets[0].authState.creds.registered = true;
    f.sockets[0].ev.emit('creds.update', {}); await f.client.credentialWrites;
    await f.client.disconnect(); await f.client.connect();
    assert.deepEqual(Array.from(f.sockets[1].browser), ['MyWhatsAppProxy', 'Chrome', '1.0.0']);
});

test('socket IQ observer surfaces a numeric server rejection without logging payloads', async t => {
    const f = await fixture(t); await f.client.connect();
    await f.update({ qr: 'mock-qr' }); await f.client.pairing.request('12025550100');
    f.sockets[0].ws.emit('CB:iq,type:error', { tag: 'iq', attrs: { type: 'error' },
        content: [{ tag: 'error', attrs: { code: '400', text: 'PRIVATE' } }] });
    assert.equal(f.client.pairing.status().code, null);
    assert.equal(f.client.pairing.status().lastError.code, 400);
});

test('socket prefers WhatsApp Web native version lookup over a stale Baileys repository version', async t => {
    const f = await fixture(t); await f.client.connect();
    assert.deepEqual(f.sockets[0].version, [2, 3000, 1]);
    assert.deepEqual(f.versionRequests, [['web', 10000]]);
});
test('version lookup falls back on failure, stale flag or malformed results without failing connect', async t => {
    for (const web of [async () => { throw Error('offline'); },
        async () => ({ version: [2, 3000, 1], isLatest: false }),
        async () => ({ version: ['bad'], isLatest: true })]) {
        const f = await fixture(t, undefined, { web }); await f.client.connect();
        assert.deepEqual(f.sockets[0].version, [2, 3000, 0]);
        assert.deepEqual(f.versionRequests, [['baileys', 10000]]);
    }
});


test('bootstrap failure exposes a recoverable diagnostic without deleting credentials', async t => {
    const f = await fixture(t, undefined, { auth: async () => { throw Error('private'); } });
    await assert.rejects(f.client.connect());
    assert.equal(f.client.getStatus().status, 'disconnected');
    assert.equal(f.client.getStatus().diagnostic.lastError, 'initialization_failed');
    assert.equal(f.client.pairing.status().canReconnect, true);
});

test('bootstrap timeout invalidates late completion', async t => {
    let resolveAuth;
    const f = await fixture(t, undefined, { auth: () => new Promise(resolve => { resolveAuth = resolve; }) });
    const attempt = f.client.connect();
    const timeout = f.timers.find(timer => timer.delay === 30000); timeout.fn();
    await assert.rejects(attempt, /initialization_timeout/);
    resolveAuth(await baileys.useMultiFileAuthState(f.authDir));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sockets.length, 0);
    assert.equal(f.client.getStatus().diagnostic.lastError, 'initialization_timeout');
});

test('socket watchdog releases a socket that never connects', async t => {
    const f = await fixture(t); await f.client.connect();
    f.timers.find(timer => timer.delay === 45000 && !timer.cancelled).fn();
    assert.equal(f.client.sock, null);
    assert.equal(f.client.getStatus().diagnostic.lastError, 'socket_timeout');
    assert.equal(f.client.pairing.status().canReconnect, true);
});

test('late QR rendering cannot resurrect an image after close', async t => {
    let resolveQr;
    const f = await fixture(t, undefined, { qr: () => new Promise(resolve => { resolveQr = resolve; }) });
    await f.client.connect();
    const pending = f.update({ qr: 'mock-qr' });
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    resolveQr('data:image/png;base64,bW9jaw=='); await pending;
    assert.equal(f.client.getQRCode(), null); assert.equal(f.client.getQRCodeImage(), null);
});

test('credential write failure blocks reconnect and is observable', async t => {
    const f = await fixture(t, undefined, { auth: async dir => {
        const auth = await baileys.useMultiFileAuthState(dir);
        return { state: auth.state, saveCreds: async () => { throw Error('private'); } };
    } });
    await f.client.connect(); f.sockets[0].ev.emit('creds.update');
    await assert.rejects(f.client.credentialWrites); await Promise.resolve();
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await assert.rejects(f.client.reconnectForPairing(), /credentials_write_failed/);
    assert.equal(f.client.getStatus().diagnostic.lastError, 'credentials_write_failed');
});

test('recoverable closures stop retrying after five attempts', async t => {
    const f = await fixture(t); await f.client.connect();
    for (let n = 0; n < 5; n++) {
        await f.update({ connection: 'close', lastDisconnect: { error: new Error('transport') } });
        const timer = f.timers.filter(item => !item.cancelled && item.delay >= 3000 && item.delay < 70000).at(-1);
        assert.ok(timer); timer.cancelled = true; await timer.fn();
    }
    await f.update({ connection: 'close', lastDisconnect: { error: new Error('transport') } });
    assert.equal(f.client.getStatus().diagnostic.lastError, 'reconnect_limit_reached');
    assert.equal(f.client.pairing.status().canReconnect, true);
});

test('a subsequent credential update can recover a failed write', async t => {
    let writes = 0;
    const f = await fixture(t, undefined, { auth: async dir => {
        const auth = await baileys.useMultiFileAuthState(dir);
        return { state: auth.state, saveCreds: async () => { if (++writes === 1) throw Error('private'); await auth.saveCreds(); } };
    } });
    await f.client.connect(); f.sockets[0].ev.emit('creds.update');
    await assert.rejects(f.client.credentialWrites);
    f.sockets[0].ev.emit('creds.update'); await f.client.credentialWrites;
    assert.equal(writes, 2);
    await f.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await f.client.reconnectForPairing(); assert.equal(f.sockets.length, 2);
});
