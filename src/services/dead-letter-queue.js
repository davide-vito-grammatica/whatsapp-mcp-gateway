const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class DeadLetterQueue {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.join(__dirname, '..', '..', 'data', 'dead-letter-queue');
        this.attachmentsDir = path.join(this.baseDir, 'attachments');
        this.clock = options.clock || (() => new Date());
        this.isRetrying = false;

        fs.mkdirSync(this.attachmentsDir, { recursive: true });
    }

    recordPath(id) {
        return path.join(this.baseDir, `${id}.json`);
    }

    async writeRecord(record) {
        const target = this.recordPath(record.id);
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.promises.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await fs.promises.rename(temporary, target);
    }

    async enqueue(payload, error) {
        const id = crypto.randomUUID();
        const now = this.clock().toISOString();
        const queuedPayload = { ...payload };

        if (Buffer.isBuffer(queuedPayload.attachmentBuffer)) {
            const attachmentName = `${id}.bin`;
            const attachmentPath = path.join(this.attachmentsDir, attachmentName);
            await fs.promises.writeFile(attachmentPath, queuedPayload.attachmentBuffer, { mode: 0o600 });
            queuedPayload.attachmentPath = attachmentName;
            delete queuedPayload.attachmentBuffer;
        }

        const record = {
            id,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            attempts: 1,
            nextAttemptAt: now,
            lastError: error?.message || String(error),
            payload: queuedPayload
        };

        await this.writeRecord(record);
        return record;
    }

    async readRecord(fileName) {
        const contents = await fs.promises.readFile(path.join(this.baseDir, fileName), 'utf8');
        return JSON.parse(contents);
    }

    async getPending() {
        const entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true });
        const records = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }

            try {
                const record = await this.readRecord(entry.name);
                if (record.status === 'pending') {
                    records.push(record);
                }
            } catch (error) {
                // Un record non leggibile non deve bloccare il replay degli altri.
                console.error(`❌ Impossibile leggere il record DLQ ${entry.name}:`, error.message);
            }
        }

        return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async payloadForRetry(record) {
        const payload = { ...record.payload };
        if (payload.attachmentPath) {
            const attachmentName = path.basename(payload.attachmentPath);
            payload.attachmentBuffer = await fs.promises.readFile(path.join(this.attachmentsDir, attachmentName));
            delete payload.attachmentPath;
        }
        return payload;
    }

    retryDelayMs(attempts) {
        // Ritenta presto dopo la prima riconnessione, poi applica backoff fino a 30 minuti.
        return Math.min(60_000 * (2 ** Math.max(0, attempts - 2)), 30 * 60_000);
    }

    async markFailed(record, error) {
        const now = this.clock();
        record.attempts += 1;
        record.updatedAt = now.toISOString();
        record.lastError = error?.message || String(error);
        record.nextAttemptAt = new Date(now.getTime() + this.retryDelayMs(record.attempts)).toISOString();
        await this.writeRecord(record);
    }

    async markDelivered(record) {
        await fs.promises.unlink(this.recordPath(record.id));
        if (record.payload.attachmentPath) {
            await fs.promises.unlink(path.join(this.attachmentsDir, path.basename(record.payload.attachmentPath))).catch(() => {});
        }
    }

    async retryPending(send, options = {}) {
        if (this.isRetrying) {
            return { skipped: true, delivered: 0, failed: 0, remaining: (await this.getPending()).length };
        }

        this.isRetrying = true;
        const limit = options.limit || 50;
        const force = options.force === true;
        let delivered = 0;
        let failed = 0;

        try {
            const now = this.clock();
            const records = await this.getPending();
            for (const record of records.slice(0, limit)) {
                if (!force && new Date(record.nextAttemptAt) > now) {
                    continue;
                }

                try {
                    await send(await this.payloadForRetry(record));
                    await this.markDelivered(record);
                    delivered += 1;
                } catch (error) {
                    await this.markFailed(record, error);
                    failed += 1;
                }
            }
        } finally {
            this.isRetrying = false;
        }

        return { delivered, failed, remaining: (await this.getPending()).length };
    }

    async summaries() {
        const records = await this.getPending();
        return records.map(({ payload, ...record }) => ({
            ...record,
            to: payload.to,
            hasImage: Boolean(payload.imageUrl),
            hasAttachment: Boolean(payload.attachmentUrl || payload.attachmentPath),
            attachmentFileName: payload.attachmentFileName || null
        }));
    }
}

module.exports = DeadLetterQueue;
