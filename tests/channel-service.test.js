const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChannelService } = require('../src/services/channel-service');
const ID = '120363123456789@newsletter';
function fixture(role = 'ADMIN') {
    const calls = [];
    const sock = { ev: new EventEmitter(), newsletterMetadata: async (type, id) => ({ id,
        thread_metadata: { name: { text: 'Casa È' }, description: { text: 'Descrizione' } },
        viewer_metadata: { role }, token: 'DO-NOT-EXPOSE' }),
        sendMessage: async (...args) => { calls.push(args); return { key: { id: 'MOCK' } }; } };
    const client = { sock, connectionStatus: 'connected' };
    return { service: new ChannelService(client, { download: async () => ({ buffer: Buffer.from('mock-image') }) }), sock, client, calls };
}
test('valid newsletter metadata and sanitized role', async () => {
    const { service } = fixture();
    const data = await service.get(ID);
    assert.equal(data.can_publish, true); assert.equal(data.name, 'Casa È');
    assert.equal(data.account_role, 'ADMIN'); assert.equal(data.token, undefined);
});
test('observe supported events, partial listing and name search', async () => {
    const { service, sock } = fixture(); service.observe(sock);
    sock.ev.emit('chats.upsert', [{ id: ID }, { id: '123@g.us' }]);
    const data = await service.list('casa e');
    assert.equal(data.channels.length, 1); assert.equal(data.inventory_complete, false);
    assert.equal((await service.list('missing')).channels.length, 0);
});
test('phone and group IDs rejected without send', async () => {
    const { service, calls } = fixture();
    for (const id of ['+393331234567', '120363123@g.us', ID + '/x', null, undefined]) {
        await assert.rejects(service.send(id, 'text'), /invalid_channel_id/);
    }
    assert.equal(calls.length, 0);
});
test('OWNER and ADMIN can submit native text once', async () => {
    for (const role of ['OWNER', 'ADMIN']) {
        const { service, calls } = fixture(role);
        const data = await service.send(ID, 'text');
        assert.equal(data.delivery_status, 'submitted'); assert.equal(data.queued, false);
        assert.deepEqual(calls, [[ID, { text: 'text', linkPreview: null }]]);
    }
});
test('non-admin and unknown role fail closed', async () => {
    for (const role of ['GUEST', 'SUBSCRIBER', null, 'OTHER']) {
        const { service, calls } = fixture(role);
        await assert.rejects(service.send(ID, 'text'), /channel_not_admin|channel_role_unknown/);
        assert.equal(calls.length, 0);
    }
});
test('ambiguous native error never retries or queues', async () => {
    const { service, sock, calls } = fixture();
    sock.sendMessage = async (...args) => { calls.push(args); throw Error('sensitive contents'); };
    const data = await service.send(ID, 'text');
    assert.equal(data.delivery_status, 'unknown'); assert.equal(data.queued, false);
    assert.equal(calls.length, 1); assert.ok(!JSON.stringify(data).includes('sensitive'));
});
test('native newsletter image, no phone path', async () => {
    const { service, calls } = fixture();
    await service.send(ID, 'caption', 'http://whatsapp-mcp:8766/media/test');
    assert.deepEqual(calls, [[ID, { image: Buffer.from('mock-image'), caption: 'caption' }]]);
});
test('empty, oversize and disconnected validation prevent sends', async () => {
    const { service, client, calls } = fixture();
    for (const text of ['', ' ', 'x'.repeat(16001)]) await assert.rejects(service.send(ID, text), /invalid_message/);
    client.connectionStatus = 'disconnected'; await assert.rejects(service.get(ID), /whatsapp_disconnected/);
    assert.equal(calls.length, 0);
});

test('newsletter media failure is sanitized and never sends', async () => {
    const { service, calls } = fixture();
    service.download = async () => { throw Object.assign(Error('https://example/?token=SECRET'), { code: 'media_http_403' }); };
    await assert.rejects(service.send(ID, 'caption', 'https://example.test/a?token=SECRET'), e => e.code === 'media_http_403' && !e.message.includes('SECRET'));
    assert.equal(calls.length, 0);
});
