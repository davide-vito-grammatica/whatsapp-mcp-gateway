const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PairingService } = require('../src/services/pairing-service');
function fixture(options = {}) {
    let time = 100000;
    const calls = [];
    const sock = { authState: { creds: { registered: false } },
        requestPairingCode: async number => { calls.push(number); return 'MOCKCODE'; } };
    const service = new PairingService({ now: () => time, ...options });
    service.attach(sock);
    service.update({ connection: 'connecting', qr: 'mock-qr' });
    return { service, sock, calls, tick: value => { time += value; } };
}
test('native API uses normalized international phone on the existing ready socket', async () => {
    const { service, calls, sock } = fixture();
    const result = await service.request('+1 (202) 555-0100');
    assert.deepEqual(calls, ['12025550100']);
    assert.equal(result.code, 'MOCKCODE'); assert.equal(service.sock, sock);
    assert.equal(result.state, 'code_ready');
});
test('registered/restarted credentials and connected sessions never request a code', async () => {
    const { service, sock, calls } = fixture();
    sock.authState.creds.registered = true;
    await assert.rejects(service.request('12025550100'), /session_already_registered/);
    service.update({ connection: 'close' });
    await assert.rejects(service.request('12025550100'), /session_already_registered/);
    service.attach(sock); service.update({ connection: 'open' });
    await assert.rejects(service.request('12025550100'), /session_already_registered/);
    assert.equal(calls.length, 0); assert.equal(service.status().code, null);
});
test('only QR readiness makes a socket eligible; invalid phones never call native API', async () => {
    const { service, sock, calls } = fixture();
    service.attach(sock);
    await assert.rejects(service.request('12025550100'), /socket_not_ready/);
    service.update({ connection: 'connecting' });
    await assert.rejects(service.request('12025550100'), /socket_not_ready/);
    service.update({ qr: 'mock-qr' });
    for (const phone of [null, {}, 'abc', '+012345678', '1', '12025550100@example.com', '+1234567890123456']) {
        await assert.rejects(service.request(phone), /invalid_phone_number/);
    }
    assert.equal(calls.length, 0);
    assert.equal((await service.request('12025550100')).code, 'MOCKCODE');
});
test('expiry clears the code, no automatic generation; active codes cannot be replaced', async () => {
    const { service, tick, calls } = fixture();
    await service.request('12025550100');
    await assert.rejects(service.request('12025550101'), /pairing_code_active/);
    tick(60001);
    assert.equal(service.status().state, 'expired'); assert.equal(service.status().code, null);
    assert.equal(calls.length, 1);
    await service.request('12025550100'); assert.equal(calls.length, 2);
});
test('concurrent requests have one native call and never create another socket', async () => {
    const { service, sock, calls } = fixture();
    let resolve;
    sock.requestPairingCode = number => { calls.push(number); return new Promise(r => { resolve = r; }); };
    const first = service.request('12025550100');
    await assert.rejects(service.request('12025550101'), /pairing_in_progress/);
    resolve('MOCKCODE'); await first;
    assert.equal(calls.length, 1); assert.equal(service.sock, sock);
});
test('native failure is sanitized and manual retry is throttled', async () => {
    const { service, sock } = fixture();
    sock.requestPairingCode = async () => { throw Error('sensitive phone/code'); };
    await assert.rejects(service.request('12025550100'), error => error.code === 'pairing_request_failed' && !error.message.includes('sensitive'));
    assert.equal(service.status().state, 'failed');
    await assert.rejects(service.request('12025550100'), error => error.status === 429);
});
test('timeout keeps native request locked and drops late results', async () => {
    const { service, sock, tick } = fixture({ timeout: 10 });
    let finish;
    sock.requestPairingCode = () => new Promise(resolve => { finish = resolve; });
    await assert.rejects(service.request('12025550100'), error => error.status === 504);
    tick(60001);
    await assert.rejects(service.request('12025550100'), /pairing_in_progress/);
    finish('LATECODE'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.status().code, null); assert.equal(service.status().state, 'timeout');
});
test('post-pairing restart clears secret, reconnects with retained credentials', async () => {
    const { service, sock } = fixture();
    await service.request('12025550100');
    sock.authState.creds.registered = true;
    service.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    assert.equal(service.status().state, 'reconnecting'); assert.equal(service.status().code, null);
    service.attach(sock); service.update({ connection: 'open' });
    assert.equal(service.status().state, 'connected'); assert.equal(service.status().canRequest, false);
});
test('socket close interrupts an in-flight operation without publishing late results', async () => {
    const { service, sock } = fixture(); let finish;
    sock.requestPairingCode = () => new Promise(resolve => { finish = resolve; });
    const request = service.request('12025550100'); await Promise.resolve();
    service.update({ connection: 'close' });
    await assert.rejects(request, /pairing_interrupted/);
    finish('LATECODE'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.status().code, null);
});

test('existing QR account identity is protected even if rc.2 registered flag is false', async () => {
    const { service, sock, calls } = fixture();
    sock.authState.creds.account = { details: Buffer.from('mock') };
    sock.authState.creds.me = { id: '12025550100:1@s.whatsapp.net' };
    await assert.rejects(service.request('12025550100'), /session_already_registered/);
    assert.equal(calls.length, 0);
});
test('QR acceptance blocks new pairing requests before the required socket restart', async () => {
    const { service, calls } = fixture();
    service.update({ isNewLogin: true });
    await assert.rejects(service.request('12025550100'), /session_already_registered/);
    assert.equal(calls.length, 0); assert.equal(service.status().state, 'reconnecting');
});

test('server IQ error invalidates the code and retains only safe diagnostics', async () => {
    const { service } = fixture(); await service.request('12025550100');
    assert.equal(service.observeRegistrationError({ content: [
        { tag: 'error', attrs: { code: '400', text: 'PRIVATE PHONE/CODE' }, content: 'PRIVATE' }
    ] }), true);
    const status = service.status();
    assert.equal(status.code, null); assert.equal(status.state, 'failed');
    assert.equal(status.lastError.code, 400);
    assert.ok(!JSON.stringify(status).includes('PRIVATE'));
});
test('unrelated, malformed and authenticated IQ errors are ignored', async () => {
    const { service, sock } = fixture();
    assert.equal(service.observeRegistrationError({ content: [{ tag: 'error', attrs: { code: '400' } }] }), false);
    await service.request('12025550100');
    assert.equal(service.observeRegistrationError({ content: [{ tag: 'error', attrs: { code: 'PRIVATE' } }] }), false);
    assert.equal(service.observeRegistrationError({ content: Buffer.from('PRIVATE') }), false);
    sock.authState.creds.registered = true;
    assert.equal(service.observeRegistrationError({ content: [{ tag: 'error', attrs: { code: '400' } }] }), false);
});
test('server IQ rejection cancels an in-flight native request and suppresses its late code', async () => {
    const { service, sock } = fixture(); let finish;
    sock.requestPairingCode = () => new Promise(resolve => { finish = resolve; });
    const promise = service.request('12025550100'); await Promise.resolve();
    service.observeRegistrationError({ content: [{ tag: 'error', attrs: { code: '429' } }] });
    await assert.rejects(promise, /pairing_registration_rejected/);
    finish('LATECODE'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.status().code, null); assert.equal(service.status().lastError.code, 429);
});


test('timed out native operation is unlocked on socket close and cannot publish late code', async () => {
    let resolveNative;
    const p = new PairingService({ timeout: 5, cooldown: 0 });
    p.attach({ authState: { creds: {} }, requestPairingCode: () => new Promise(resolve => { resolveNative = resolve; }) });
    p.update({ qr: 'mock' });
    await assert.rejects(p.request('12025550100'), /pairing_timeout/);
    assert.equal(p.status().canReconnect, true);
    p.update({ connection: 'close' });
    assert.equal(p.pending, null);
    resolveNative('MOCKCODE'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.status().code, null);
    assert.equal(p.status().canReconnect, true);
});

test('status explains why pairing is unavailable for retained credentials', () => {
    const p = new PairingService(); p.attach({ authState: { creds: { registered: true } } });
    p.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(p.status().unavailableReason, 'credentials_retained');
    assert.equal(p.status().canRequest, false); assert.equal(p.status().canReconnect, true);
});
