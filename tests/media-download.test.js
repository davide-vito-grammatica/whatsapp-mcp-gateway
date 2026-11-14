const { test } = require('node:test');
const assert = require('node:assert/strict');
const media = require('../src/services/media-download');
const downloadMedia = (url, options) => media.downloadMedia(url, { allowedHosts: ['example.test'], lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], ...options });
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const response = (status, body = png, mime = 'image/png') => ({ ok: status === 200, status,
    headers: new Headers({ 'content-type': mime }), body: (async function* () { yield body; })() });
for (const status of [401, 403, 404, 429, 500]) test(`HTTP ${status} classified safely`, async () => {
    await assert.rejects(downloadMedia('https://example.test/a?token=SECRET', { fetchImpl: async () => response(status) }),
        e => e.code === `media_http_${status}` && e.temporary === (status === 429 || status === 500) && !e.message.includes('SECRET'));
});
test('timeout resolves even when HTTP promise ignores abort', async () => {
    await assert.rejects(downloadMedia('https://example.test/', { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), e => e.code === 'media_timeout');
});
test('rejects non-image bytes and exceeds size limit', async () => {
    await assert.rejects(downloadMedia('https://example.test/', { fetchImpl: async () => response(200, Buffer.from('bad')) }), /media_invalid_image/);
    await assert.rejects(downloadMedia('https://example.test/', { maxBytes: 4, fetchImpl: async () => response(200) }), /media_too_large/);
});
test('accepts matching image bytes', async () => {
    assert.deepEqual((await downloadMedia('https://example.test/', { fetchImpl: async () => response(200) })).buffer, png);
});

for (const [cause, code] of [['ENOTFOUND', 'media_dns_error'], ['ECONNRESET', 'media_connection_interrupted']]) {
    test(`classifies ${cause} without leaking URL`, async () => {
        await assert.rejects(downloadMedia('https://example.test/a?token=SECRET', { fetchImpl: async () => {
            throw Object.assign(new Error('sensitive'), { cause: { code: cause } });
        } }), e => e.code === code && e.temporary && !e.message.includes('SECRET'));
    });
}
