'use strict';
const { resolveTarget, pinnedFetch } = require('./media-target');

class MediaError extends Error {
    constructor(code, temporary = false, status = null) {
        super(code); this.code = code; this.temporary = temporary; this.httpStatus = status;
    }
}

function imageType(data) {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

async function downloadMedia(url, { timeoutMs = 10000, maxBytes = 10 * 1024 * 1024, image = true, fetchImpl, ...targetOptions } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new MediaError('media_invalid_url'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new MediaError('media_invalid_url');
    const controller = new AbortController();
    let timer;
    const operation = async () => {
        let response;
        let target;
        try { target = await resolveTarget(parsed.href, targetOptions); }
        catch (error) {
            if (error.message === 'media_target_denied' || error.message === 'media_invalid_url') throw new MediaError(error.message);
            throw new MediaError('media_dns_error', true);
        }
        try { response = await (fetchImpl || (() => pinnedFetch(target, { signal: controller.signal })))(parsed.href, { signal: controller.signal, redirect: 'error' }); }
        catch (error) {
            if (controller.signal.aborted) throw new MediaError('media_timeout', true);
            const code = error?.cause?.code || error?.code;
            if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new MediaError('media_dns_error', true);
            if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) throw new MediaError('media_connection_interrupted', true);
            throw new MediaError('media_network_error', true);
        }
        if (!response.ok) {
            const status = response.status;
            controller.abort();
            throw new MediaError(`media_http_${status}`, status === 429 || status >= 500, status);
        }
        const size = Number(response.headers.get('content-length'));
        if (Number.isFinite(size) && size > maxBytes) { controller.abort(); throw new MediaError('media_too_large'); }
        const chunks = []; let total = 0;
        try {
            for await (const chunk of response.body) {
                total += chunk.length;
                if (total > maxBytes) { controller.abort(); throw new MediaError('media_too_large'); }
                chunks.push(Buffer.from(chunk));
            }
        } catch (error) {
            if (error instanceof MediaError) throw error;
            throw new MediaError(controller.signal.aborted ? 'media_timeout' : 'media_network_error', true);
        }
        const data = Buffer.concat(chunks);
        if (!data.length) throw new MediaError('media_empty');
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (image && (!imageType(data) || imageType(data) !== mime)) throw new MediaError('media_invalid_image');
        return { buffer: data, mime, host: parsed.hostname };
    };
    try {
        return await Promise.race([operation(), new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new MediaError('media_timeout', true)); }, timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
module.exports = { downloadMedia, MediaError, imageType };
