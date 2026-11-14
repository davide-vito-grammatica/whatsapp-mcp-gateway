const { test } = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { generateThumbnail } = require('@whiskeysockets/baileys');
test('patched native media stack generates a real thumbnail from synthetic PNG bytes', async () => {
    const png = await QRCode.toBuffer('synthetic-offline-image');
    const jpeg = await sharp(png).resize(32, 32).jpeg().toBuffer();
    assert.equal((await sharp(jpeg).metadata()).width, 32);
    const result = await generateThumbnail(png, 'image');
    assert.ok(result.thumbnail && result.thumbnail.length > 0);
});

test('text links never invoke native link-preview HTTP downloads', async () => {
    const { generateWAMessageContent } = require('@whiskeysockets/baileys');
    let requests = 0;
    const result = await generateWAMessageContent({ text: 'http://127.0.0.1/private', linkPreview: null },
        { getUrlInfo: async () => { requests++; throw Error('must not fetch'); } });
    assert.equal(requests, 0); assert.ok(result.extendedTextMessage);
});
