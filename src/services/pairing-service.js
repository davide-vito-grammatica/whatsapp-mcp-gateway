// Pairing material stays in memory and is exposed only by the admin router.
class PairingError extends Error {
    constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

class PairingService {
    constructor({ now = Date.now, ttl = 60000, cooldown = 60000, timeout = 20000 } = {}) {
        this.now = now;
        this.ttl = ttl; // Conservative local display window, not a server expiry guarantee.
        this.cooldown = cooldown;
        this.timeout = timeout;
        this.sock = null;
        this.ready = false;
        this.state = 'idle';
        this.code = null;
        this.expiresAt = 0;
        this.retryAt = 0;
        this.pending = null;
        this.connection = 'disconnected';
        this.credentialsRetained = false;
        this.lastError = null;
        this.lastDisconnectCode = null;
    }

    hasSession() {
        const creds = this.sock?.authState?.creds;
        // QR-paired rc.2 credentials can have an account/device identity while
        // registered is still false. A mere me.id from requestPairingCode is not
        // sufficient: Baileys sets that before the phone accepts the pairing.
        return !!(creds?.registered || (creds?.account && creds?.me?.id));
    }

    attach(sock) {
        this.sock = sock;
        this.ready = false;
        this.code = null;
        this.state = 'idle';
        this.credentialsRetained = this.hasSession();
    }

    update({ connection, qr, lastDisconnect, isNewLogin } = {}) {
        if (connection) this.connection = connection === 'open' ? 'connected' : connection;
        // connecting is emitted before the encrypted handshake in rc.2. A QR
        // confirms that registration is actually ready on this socket.
        if (qr) this.ready = true;
        if (isNewLogin) {
            this.credentialsRetained = true;
            this.ready = false;
            this.code = null;
            this.state = 'reconnecting';
        }
        if (connection === 'open') {
            this.code = null;
            this.state = 'connected';
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            this.lastDisconnectCode = Number.isInteger(reason) ? reason : null;
            this.credentialsRetained = this.hasSession() || this.credentialsRetained;
            this.sock = null;
            this.ready = false;
            this.code = null;
            this.state = lastDisconnect?.error?.output?.statusCode === 515 ? 'reconnecting' : 'interrupted';
            if (this.pending) {
                const pending = this.pending; this.pending = null;
                pending.cancel(new PairingError('pairing_interrupted'));
            }
        }
    }

    observeRegistrationError(node) {
        if (this.hasSession() || (!this.pending && !this.code)) return false;
        const error = Array.isArray(node?.content) && node.content.find(child => child.tag === 'error');
        const value = error?.attrs?.code;
        if (!/^\d{3}$/.test(String(value || ''))) return false;
        // No raw protocol nodes, payloads or text fields are retained or logged.
        this.lastError = { kind: 'server_iq_error', code: Number(value), at: this.now() };
        this.code = null;
        this.state = 'failed';
        if (this.pending) this.pending.cancel(new PairingError('pairing_registration_rejected', 502));
        return true;
    }

    status() {
        const registered = this.hasSession() || this.credentialsRetained;
        if (this.code && this.now() >= this.expiresAt) {
            this.code = null;
            this.state = 'expired';
        }
        if (registered || this.connection === 'connected') this.code = null;
        return {
            connection: this.connection,
            state: this.state,
            registered,
            canReconnect: (!this.sock && !this.pending) || (this.state === 'timeout' && !!this.sock),
            unavailableReason: this.connection === 'connected' ? 'connected' :
                registered ? 'credentials_retained' : this.pending ? 'pairing_in_progress' :
                !this.sock ? 'socket_disconnected' : !this.ready ? 'socket_not_ready' :
                this.code ? 'pairing_code_active' : this.now() < this.retryAt ? 'pairing_rate_limited' : null,
            canRequest: !!this.sock && this.ready && !registered && this.connection !== 'connected' &&
                !this.pending && !this.code && this.now() >= this.retryAt,
            code: this.code,
            expiresAt: this.code ? this.expiresAt : null,
            retryAt: this.retryAt,
            lastError: this.lastError,
            lastDisconnectCode: this.lastDisconnectCode
        };
    }

    async request(phoneNumber) {
        // Accept a leading + and common visual separators, reject other input.
        if (typeof phoneNumber !== 'string' || !/^\+?[\d ()-]+$/.test(phoneNumber)) {
            throw new PairingError('invalid_phone_number', 400);
        }
        const phone = phoneNumber.replace(/[+ ()-]/g, '');
        if (!/^[1-9]\d{6,14}$/.test(phone)) throw new PairingError('invalid_phone_number', 400);
        const status = this.status();
        if (status.registered || this.connection === 'connected') throw new PairingError('session_already_registered');
        if (this.pending) throw new PairingError('pairing_in_progress');
        if (this.code) throw new PairingError('pairing_code_active');
        if (this.now() < this.retryAt) throw new PairingError('pairing_rate_limited', 429);
        if (!this.sock || !this.ready) throw new PairingError('socket_not_ready');
        if (typeof this.sock.requestPairingCode !== 'function') throw new PairingError('pairing_not_supported', 501);

        const sock = this.sock;
        const attempt = {};
        this.pending = attempt;
        this.state = 'requesting';
        this.lastError = null;
        this.retryAt = this.now() + this.cooldown;
        let timer;
        let nativeSettled = false;
        const aborted = new Promise((_, reject) => {
            attempt.cancel = reject;
            timer = setTimeout(() => reject(new PairingError('pairing_timeout', 504)), this.timeout);
        });
        // A timed-out native operation cannot be cancelled. Keep the lock until it
        // settles (or its socket closes), and never publish its late result.
        const native = Promise.resolve().then(() => sock.requestPairingCode(phone)).finally(() => {
            nativeSettled = true;
            if (this.pending === attempt) this.pending = null;
        });
        try {
            const code = await Promise.race([native, aborted]);
            if (this.sock !== sock || this.hasSession() || this.credentialsRetained || this.connection === 'connected') {
                throw new PairingError('pairing_interrupted');
            }
            if (typeof code !== 'string' || !code.length) throw new PairingError('pairing_request_failed', 502);
            this.code = code;
            this.expiresAt = this.now() + this.ttl;
            this.state = 'code_ready';
            return this.status();
        } catch (error) {
            this.code = null;
            if (this.sock === sock && this.connection !== 'connected') {
                this.state = error.code === 'pairing_timeout' ? 'timeout' : 'failed';
            }
            throw error instanceof PairingError ? error : new PairingError('pairing_request_failed', 502);
        } finally {
            clearTimeout(timer);
            if ((nativeSettled || this.sock !== sock) && this.pending === attempt) this.pending = null;
        }
    }
}

module.exports = { PairingService, PairingError };
