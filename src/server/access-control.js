'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

function secret(env, name) {
    try { return env[name + '_FILE'] ? fs.readFileSync(env[name + '_FILE'], 'utf8').trim() : env[name] || ''; }
    catch (_) { return ''; }
}
const digest = value => crypto.createHash('sha256').update(value).digest();
const matches = (provided, token) => token.length >= 32 && crypto.timingSafeEqual(digest(provided), digest('Bearer ' + token));
function routeLevel(path, method) {
    if (['GET', 'HEAD'].includes(method) && (['/health', '/session/link', '/session/link.js', '/api-docs', '/api-docs.json'].includes(path) || path.startsWith('/api-docs/'))) return 'public';
    if (path === '/qr-code' || path.startsWith('/admin/') || path.startsWith('/session/') ||
        path.startsWith('/dead-letter-queue') || (method !== 'GET' &&
        (path.startsWith('/keepalive/') || path.startsWith('/groups/')))) return 'admin';
    return 'api';
}
function accessControl(env = process.env, now = Date.now) {
    const api = secret(env, 'WHATSAPP_API_TOKEN'), admin = secret(env, 'WHATSAPP_ADMIN_TOKEN');
    const origins = new Set((env.WHATSAPP_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
    const buckets = new Map();
    const perMinute = Math.min(600, Math.max(10, Number(env.API_REQUESTS_PER_MINUTE) || 120));
    let inflight = 0;
    return (req, res, next) => {
        res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
        res.set('X-Content-Type-Options', 'nosniff');
        const origin = req.get('origin');
        if (origin) {
            if (origin !== req.protocol + '://' + req.get('host') && !origins.has(origin)) {
                return res.status(403).json({ error: 'origin_denied' });
            }
            res.vary('Origin'); res.set('Access-Control-Allow-Origin', origin);
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        }
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        const level = routeLevel(req.path, req.method);
        if (level === 'public') return next();
        // Bound cardinality, ignore forwarded client addresses, and rate-limit failed auth too.
        const time = now(), key = req.socket.remoteAddress || 'unknown';
        for (const [address, item] of buckets) if (item.until <= time) buckets.delete(address);
        if (!buckets.has(key) && buckets.size >= 1024) return res.status(429).json({ error: 'rate_limited' });
        const item = buckets.get(key) || { count: 0, until: time + 60000 };
        buckets.set(key, item);
        if (++item.count > perMinute) {
            res.set('Retry-After', String(Math.max(1, Math.ceil((item.until - time) / 1000))));
            return res.status(429).json({ error: 'rate_limited' });
        }
        if ((level === 'api' ? api.length < 32 : admin.length < 32) || (api && api === admin)) {
            return res.status(503).json({ error: 'authentication_not_configured' });
        }
        const provided = req.get('authorization') || '';
        if (!matches(provided, admin) && (level !== 'api' || !matches(provided, api))) {
            res.set('WWW-Authenticate', 'Bearer realm="whatsapp-proxy"');
            return res.status(401).json({ error: 'unauthorized' });
        }
        if (inflight >= 16) return res.status(503).json({ error: 'request_capacity' });
        inflight++;
        let released = false;
        const release = () => { if (!released) { released = true; inflight--; } };
        res.once('finish', release); res.once('close', release);
        next();
    };
}
module.exports = { accessControl, routeLevel, secret };
