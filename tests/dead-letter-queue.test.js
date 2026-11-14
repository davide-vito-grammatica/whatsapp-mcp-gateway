const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const DeadLetterQueue = require('../src/services/dead-letter-queue');

async function createQueue() {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whatsapp-dlq-'));
    return { baseDir, queue: new DeadLetterQueue({ baseDir }) };
}

test('persists a failed binary attachment and removes it only after delivery', async (t) => {
    const { baseDir, queue } = await createQueue();
    t.after(() => fs.promises.rm(baseDir, { recursive: true, force: true }));

    const queued = await queue.enqueue({
        to: '390000000000',
        message: 'Documento',
        attachmentBuffer: Buffer.from('pdf-content'),
        attachmentFileName: 'documento.pdf',
        attachmentMimeType: 'application/pdf'
    }, new Error('WhatsApp client is not connected.'));

    assert.equal((await queue.getPending()).length, 1);
    assert.equal(fs.existsSync(path.join(baseDir, 'attachments', `${queued.id}.bin`)), true);

    let retriedPayload;
    const result = await queue.retryPending(async (payload) => {
        retriedPayload = payload;
    }, { force: true });

    assert.equal(result.delivered, 1);
    assert.equal(result.remaining, 0);
    assert.equal(retriedPayload.attachmentBuffer.toString(), 'pdf-content');
    assert.equal(fs.existsSync(path.join(baseDir, 'attachments', `${queued.id}.bin`)), false);
});

test('keeps a record and schedules another retry when delivery still fails', async (t) => {
    const { baseDir, queue } = await createQueue();
    t.after(() => fs.promises.rm(baseDir, { recursive: true, force: true }));

    await queue.enqueue({ to: '390000000000', message: 'Riprova' }, new Error('Connection closed'));
    const result = await queue.retryPending(async () => {
        throw new Error('Connection closed');
    }, { force: true });

    const [record] = await queue.getPending();
    assert.equal(result.failed, 1);
    assert.equal(record.attempts, 2);
    assert.ok(new Date(record.nextAttemptAt) > new Date(record.updatedAt));
});
