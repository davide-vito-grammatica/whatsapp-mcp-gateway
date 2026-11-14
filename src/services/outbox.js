'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadMedia, MediaError } = require('./media-download');

const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
class Outbox {
    constructor(options = {}) {
        this.dir = options.baseDir || path.join(__dirname, '../../data/outbox-v2');
        this.files = path.join(this.dir, 'attachments');
        this.maxAttempts = positive(options.maxAttempts || process.env.OUTBOX_MAX_ATTEMPTS, 5);
        this.maxAge = positive(options.maxAge || process.env.OUTBOX_MAX_AGE_MS, 24 * 3600 * 1000);
        this.maxBytes = positive(options.maxBytes || process.env.OUTBOX_MAX_BYTES, 100 * 1024 * 1024);
        this.maxRecords = positive(options.maxRecords || process.env.OUTBOX_MAX_RECORDS, 1000);
        this.timeout = positive(options.timeout || process.env.OUTBOX_SEND_TIMEOUT_MS, 30000);
        this.retention = positive(options.retention || process.env.OUTBOX_RETENTION_MS, 7 * 24 * 3600 * 1000);
        this.concurrency = Math.min(positive(options.concurrency || process.env.OUTBOX_CONCURRENCY, 2), 10);
        this.clock = options.clock || Date.now; this.random = options.random || Math.random;
        this.mediaOptions = options.mediaOptions || {};
        this.running = false; this.inflight = 0; this.lock = Promise.resolve();
        fs.mkdirSync(this.files, { recursive: true, mode: 0o700 });
        fs.chmodSync(this.dir, 0o700); fs.chmodSync(this.files, 0o700);
    }
    file(id) { return path.join(this.dir, `${id}.json`); }
    async write(record) {
        const dest = this.file(record.id), tmp = `${dest}.${crypto.randomUUID()}.tmp`;
        try { await fs.promises.writeFile(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await fs.promises.rename(tmp, dest); }
        finally { await fs.promises.unlink(tmp).catch(() => {}); }
    }
    async records() {
        const names = await fs.promises.readdir(this.dir); const records = [];
        for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
            try { records.push(JSON.parse(await fs.promises.readFile(path.join(this.dir, name), 'utf8'))); }
            catch (_) { console.error('Outbox: unreadable record'); }
        }
        return records;
    }
    async cleanup(records) {
        for (const record of records) {
            if (['sent', 'failed'].includes(record.status) && this.clock() - record.updatedAt > this.retention) {
                await fs.promises.unlink(this.file(record.id)).catch(() => {});
                if (record.mediaFile) await fs.promises.unlink(path.join(this.files, path.basename(record.mediaFile))).catch(() => {});
            }
        }
    }
    async enqueue(payload, { mediaPolicy = 'required' } = {}) {
        const run = async () => {
            const existing = await this.records(); await this.cleanup(existing);
            const remaining = await this.records();
            if (remaining.length >= this.maxRecords) throw Object.assign(new Error('outbox_capacity'), { code: 'outbox_capacity' });
            const bytes = (await Promise.all((await fs.promises.readdir(this.files)).map(async n => (await fs.promises.stat(path.join(this.files, n))).size))).reduce((a,b) => a+b, 0);
            const buffer = payload.imageBuffer || payload.attachmentBuffer;
            if (bytes + (buffer?.length || 0) > this.maxBytes) throw Object.assign(new Error('outbox_capacity'), { code: 'outbox_capacity' });
            const id = crypto.randomUUID(), now = this.clock();
            const record = { id, version: 2, status: 'pending', createdAt: now, updatedAt: now, attempts: 0,
                nextAttemptAt: now, mediaPolicy, payload: { ...payload } };
            if (buffer) {
                record.mediaFile = `${id}.bin`; record.mediaKind = payload.imageBuffer ? 'image' : 'attachment';
                delete record.payload.imageBuffer; delete record.payload.attachmentBuffer;
                const dest = path.join(this.files, record.mediaFile), tmp = `${dest}.${crypto.randomUUID()}.tmp`;
                try { await fs.promises.writeFile(tmp, buffer, { mode: 0o600, flag: 'wx' }); await fs.promises.rename(tmp, dest); }
                finally { await fs.promises.unlink(tmp).catch(() => {}); }
            }
            try { await this.write(record); } catch (error) {
                if (record.mediaFile) await fs.promises.unlink(path.join(this.files, record.mediaFile)).catch(() => {});
                throw error;
            }
            return record;
        };
        const result = this.lock.then(run); this.lock = result.catch(() => {}); return result;
    }
    async storeDeferred(record, buffer, image) {
        const run = async () => {
            const names = await fs.promises.readdir(this.files);
            const current = (await Promise.all(names.map(async n => (await fs.promises.stat(path.join(this.files, n))).size))).reduce((a, b) => a + b, 0);
            if (current + buffer.length > this.maxBytes) throw Object.assign(new Error('outbox_capacity'), { code: 'outbox_capacity' });
            const name = `${record.id}.bin`, tmp = path.join(this.files, `${name}.${crypto.randomUUID()}.tmp`);
            try { await fs.promises.writeFile(tmp, buffer, { mode: 0o600, flag: 'wx' }); await fs.promises.rename(tmp, path.join(this.files, name)); }
            finally { await fs.promises.unlink(tmp).catch(() => {}); }
            record.mediaFile = name; record.mediaKind = image ? 'image' : 'attachment';
            delete record.payload.imageUrl; delete record.payload.attachmentUrl;
            await this.write(record);
        };
        const result = this.lock.then(run); this.lock = result.catch(() => {}); return result;
    }
    async process(record, send, isConnected) {
        if (!isConnected()) return 'paused';
        const now = this.clock();
        if (now - record.createdAt >= this.maxAge) { record.status = 'failed'; record.lastError = 'expired'; }
        else if (record.attempts >= this.maxAttempts) { record.status = 'failed'; record.lastError = 'attempts_exhausted'; }
        if (record.status === 'failed') { record.updatedAt = now; await this.write(record); return 'failed'; }
        const payload = { ...record.payload };
        if (record.mediaFile) {
            try { payload[record.mediaKind === 'image' ? 'imageBuffer' : 'attachmentBuffer'] = await fs.promises.readFile(path.join(this.files, path.basename(record.mediaFile))); }
            catch (_) { record.status = 'failed'; record.lastError = 'media_file_unavailable'; record.updatedAt = now; await this.write(record); return 'failed'; }
        }
        if (payload.imageUrl || payload.attachmentUrl) {
            try {
                const image = !!payload.imageUrl;
                const media = await downloadMedia(payload.imageUrl || payload.attachmentUrl, { ...this.mediaOptions, image });
                await this.storeDeferred(record, media.buffer, image);
                delete payload.imageUrl; delete payload.attachmentUrl;
                payload[image ? 'imageBuffer' : 'attachmentBuffer'] = media.buffer;
            } catch (error) {
                if (!(error instanceof MediaError)) throw error;
                record.attempts++; record.updatedAt = this.clock(); record.lastError = error.code || 'media_failed';
                if (record.mediaPolicy === 'optional' && payload.message && !['media_target_denied', 'media_invalid_url'].includes(error.code)) {
                    delete payload.imageUrl; delete payload.attachmentUrl; delete record.payload.imageUrl; delete record.payload.attachmentUrl;
                } else {
                    record.status = error.temporary && record.mediaPolicy === 'deferred' && record.attempts < this.maxAttempts ? 'pending' : 'failed';
                    record.nextAttemptAt = this.clock() + Math.min(60000 * 2 ** Math.max(0, record.attempts - 1), 1800000) + Math.floor(this.random() * 1000);
                    await this.write(record); return record.status;
                }
            }
        }
        if (!isConnected() || this.inflight >= this.concurrency) return 'paused';
        this.inflight++;
        record.status = 'sending'; record.attempts++; record.updatedAt = this.clock(); record.lastError = null;
        try { await this.write(record); } catch (error) { this.inflight--; throw error; } // Durable intent precedes send.
        let timer;
        const sending = Promise.resolve().then(() => send(payload)).finally(() => { this.inflight--; });
        try {
            await Promise.race([sending, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('send_timeout')), this.timeout);
            })]);
            record.status = 'sent'; record.lastError = null;
        } catch (_) { record.status = 'unknown'; record.lastError = 'delivery_unconfirmed'; }
        finally { clearTimeout(timer); }
        record.updatedAt = this.clock(); await this.write(record);
        if (record.status === 'sent' && record.mediaFile) {
            await fs.promises.unlink(path.join(this.files, path.basename(record.mediaFile))).catch(() => {});
        }
        return record.status;
    }
    async retryPending(send, { isConnected = () => true } = {}) {
        if (this.running) return { skipped: true };
        this.running = true;
        try {
            const records = await this.records(); await this.cleanup(records);
            // A crash while sending has an ambiguous outcome; never replay it automatically.
            for (const record of records.filter(r => r.status === 'sending')) {
                record.status = 'unknown'; record.lastError = 'process_interrupted'; record.updatedAt = this.clock(); await this.write(record);
            }
            const due = records.filter(r => r.status === 'pending' && r.nextAttemptAt <= this.clock());
            let next = 0;
            await Promise.all(Array.from({ length: this.concurrency }, async () => {
                while (next < due.length) {
                    const record = due[next++];
                    try { await this.process(record, send, isConnected); }
                    catch (_) { console.error('Outbox: record processing failed'); }
                }
            }));
            return this.counts();
        } finally { this.running = false; }
    }
    async counts() {
        const records = await this.records(); const counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0 };
        for (const r of records) if (Object.hasOwn(counts, r.status)) counts[r.status]++;
        return counts;
    }
    async summaries() {
        return (await this.records()).map(({ id, status, attempts, createdAt, updatedAt, nextAttemptAt, lastError }) =>
            ({ id, status, attempts, createdAt, updatedAt, nextAttemptAt, lastError }));
    }
}
module.exports = Outbox;
