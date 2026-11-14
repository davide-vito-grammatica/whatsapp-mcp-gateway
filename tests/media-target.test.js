const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { resolveTarget, pinnedFetch } = require('../src/services/media-target');
const options = { allowedHosts: ['images.example'], lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] };
for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    test(`private/reserved media address ${address} denied`, async () => {
        await assert.rejects(resolveTarget('https://images.example/a', { ...options, lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /media_target_denied/);
    });
}
test('mixed DNS answers, userinfo, HTTP, ports, and unapproved hosts fail closed', async () => {
    for (const url of ['http://images.example/a', 'https://u:p@images.example/a', 'https://images.example:8443/a', 'https://other.example/a']) await assert.rejects(resolveTarget(url, options));
    await assert.rejects(resolveTarget('https://images.example/a', { ...options, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /media_target_denied/);
});
test('private MCP exception allows only exact configured origin and staged media path', async () => {
    const o = { mcpOrigin: 'http://whatsapp-mcp:8766', lookupImpl: async () => [{ address: '172.18.0.4', family: 4 }] };
    const url = 'http://whatsapp-mcp:8766/media/' + 'x'.repeat(43);
    assert.equal((await resolveTarget(url, o)).address, '172.18.0.4');
    for (const denied of [url + '?q=x', url.replace('/media/', '/admin/'), url.replace(':8766', ':8767'), url.replace('whatsapp-mcp', 'attacker')]) await assert.rejects(resolveTarget(denied, o), /media_target_denied/);
    await assert.rejects(resolveTarget(url, { ...o, lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] }), /media_target_denied/);
});
test('connection uses validated DNS address, original TLS hostname and no reusable agent', async t => {
    let queried = false;
    t.mock.method(https, 'get', (url, opts, callback) => {
        assert.equal(url.hostname, 'images.example'); assert.equal(opts.agent, false);
        opts.lookup('images.example', { all: true }, (err, answers) => { assert.ifError(err); assert.equal(answers[0].address, '93.184.216.34'); queried = true; });
        queueMicrotask(() => callback({ statusCode: 302, socket: { remoteAddress: '93.184.216.34' }, headers: {}, destroy() {} }));
        return new EventEmitter();
    });
    const target = await resolveTarget('https://images.example/a', options);
    assert.equal((await pinnedFetch(target, {})).status, 302); assert.equal(queried, true);
});
