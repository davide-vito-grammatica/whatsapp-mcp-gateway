'use strict';
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const ipaddr = require('ipaddr.js');

const range = address => { try { return ipaddr.process(address).range(); } catch (_) { return 'invalid'; } };
async function resolveTarget(url, { allowedHosts = (process.env.MEDIA_ALLOWED_HOSTS || '').split(','),
    mcpOrigin = process.env.MEDIA_MCP_ORIGIN || '', lookupImpl = dns.lookup } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw Error('media_invalid_url'); }
    if (parsed.username || parsed.password || parsed.hash) throw Error('media_invalid_url');
    let internal = false;
    if (mcpOrigin) {
        const origin = new URL(mcpOrigin);
        internal = origin.protocol === 'http:' && parsed.origin === origin.origin &&
            !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash &&
            /^\/media\/[A-Za-z0-9_-]{32,128}$/.test(parsed.pathname) && !parsed.search;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!internal && (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') ||
        !allowedHosts.map(v => v.trim().toLowerCase()).includes(hostname))) throw Error('media_target_denied');
    const answers = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }] :
        await lookupImpl(hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(a => internal ? !['private', 'uniqueLocal'].includes(range(a.address)) : range(a.address) !== 'unicast')) {
        throw Error('media_target_denied');
    }
    return { parsed, address: answers[0].address, family: answers[0].family };
}
function pinnedFetch(target, { signal }) {
    return new Promise((resolve, reject) => {
        const transport = target.parsed.protocol === 'https:' ? https : http;
        const request = transport.get(target.parsed, { signal, agent: false,
            lookup: (hostname, options, callback) => options.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family)
        }, response => {
            const actual = response.socket.remoteAddress;
            if (!actual || ipaddr.process(actual).toString() !== ipaddr.process(target.address).toString()) {
                response.destroy(); return reject(Error('media_target_denied'));
            }
            // No redirect following; the downloader classifies non-2xx responses.
            resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
                headers: { get: name => response.headers[name.toLowerCase()] || null }, body: response });
        });
        request.once('error', reject);
    });
}
module.exports = { resolveTarget, pinnedFetch };
