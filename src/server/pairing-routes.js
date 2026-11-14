const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { PairingError } = require('../services/pairing-service');

function pairingRoutes(client, token = process.env.WHATSAPP_ADMIN_TOKEN || '') {
    // Optional mounted secret file, taking precedence over the environment value.
    if (process.env.WHATSAPP_ADMIN_TOKEN_FILE) {
        try { token = fs.readFileSync(process.env.WHATSAPP_ADMIN_TOKEN_FILE, 'utf8').trim(); }
        catch (_) { token = ''; } // Fail closed; never log secret paths/contents.
    }
    const router = express.Router();
    const digest = value => crypto.createHash('sha256').update(value).digest();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        if (token.length < 32) return res.status(503).json({ error: 'admin_auth_not_configured' });
        const provided = req.get('authorization') || '';
        if (!crypto.timingSafeEqual(digest(provided), digest(`Bearer ${token}`))) {
            return res.status(401).json({ error: 'admin_unauthorized' });
        }
        // Bearer headers are never sent automatically by a browser. Require JSON
        // as well, so cross-origin HTML forms cannot initiate pairing.
        if (req.method === 'POST' && !req.is('application/json')) {
            return res.status(415).json({ error: 'json_required' });
        }
        next();
    });
    router.use(express.json({ limit: '1kb' }));
    router.use((error, req, res, next) => {
        // Body-parser errors can contain the submitted phone/body. Never log or
        // return the error object, including for malformed JSON.
        res.status(error.status === 413 ? 413 : 400).json({
            error: error.status === 413 ? 'pairing_payload_too_large' : 'invalid_json'
        });
    });
    router.get('/status', (req, res) => res.json(client.pairing.status()));
    router.post('/reconnect', async (req, res) => {
        try { res.json(await client.reconnectForPairing()); }
        catch (error) {
            if (error.status === 429) res.set('Retry-After', '60');
            res.status(error instanceof PairingError ? error.status : 502).json({
                error: error instanceof PairingError ? error.code : 'pairing_reconnect_failed'
            });
        }
    });
    router.post('/code', async (req, res) => {
        try { res.json(await client.pairing.request(req.body?.phoneNumber)); }
        catch (error) {
            const status = error instanceof PairingError ? error.status : 500;
            if (status === 429) res.set('Retry-After', String(Math.max(1,
                Math.ceil((client.pairing.retryAt - Date.now()) / 1000))));
            res.status(status).json({ error: error instanceof PairingError ? error.code : 'pairing_request_failed' });
        }
    });
    return router;
}
module.exports = pairingRoutes;
