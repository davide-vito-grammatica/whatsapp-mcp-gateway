const { downloadMedia } = require('./media-download');
/** Native newsletters only; never use phone normalization or the dead-letter queue. */
const CHANNEL = /^[1-9][0-9]{5,29}@newsletter$/;
class ChannelError extends Error {
    constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
class ChannelService {
    constructor(client, { download = downloadMedia } = {}) { this.client = client; this.known = new Set(); this.download = download; }
    remember(id) {
        if (typeof id === 'string' && CHANNEL.test(id) && this.known.size < 1000) this.known.add(id);
    }
    observe(sock) {
        // Supported Baileys events; no private GraphQL queries or scraping.
        sock.ev.on('chats.upsert', chats => chats.forEach(chat => this.remember(chat.id)));
        sock.ev.on('messaging-history.set', data => (data.chats || []).forEach(chat => this.remember(chat.id)));
        sock.ev.on('messages.upsert', data => (data.messages || []).forEach(msg => this.remember(msg.key?.remoteJid)));
        for (const name of ['newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update']) {
            sock.ev.on(name, data => this.remember(data.id));
        }
    }
    socket(id) {
        if (id !== undefined && (typeof id !== 'string' || !CHANNEL.test(id))) throw new ChannelError('invalid_channel_id');
        if (!this.client.sock || this.client.connectionStatus !== 'connected') throw new ChannelError('whatsapp_disconnected', 503);
        return this.client.sock;
    }
    async get(id) {
        if (typeof id !== 'string' || !CHANNEL.test(id)) throw new ChannelError('invalid_channel_id');
        const sock = this.socket(id);
        let raw;
        try { raw = await sock.newsletterMetadata('jid', id); }
        catch (_) { throw new ChannelError('channel_metadata_unavailable', 502); }
        if (!raw || raw.id !== id) throw new ChannelError('channel_not_found', 404);
        this.remember(id);
        // rc.2 returns raw metadata, despite incomplete NewsletterMetadata typings.
        const role = raw.viewer_metadata?.role;
        const accountRole = ['OWNER', 'ADMIN', 'SUBSCRIBER', 'GUEST'].includes(role) ? role : 'UNKNOWN';
        const text = value => typeof value === 'string' ? value.slice(0, 256) : '';
        const name = raw.thread_metadata?.name;
        const description = raw.thread_metadata?.description;
        return { id, name: text(typeof name === 'object' ? name?.text : name) || text(raw.name),
            description: text(typeof description === 'object' ? description?.text : description) || text(raw.description),
            account_role: accountRole, can_publish: ['OWNER', 'ADMIN'].includes(accountRole),
            followed: accountRole === 'SUBSCRIBER' || accountRole === 'ADMIN' || accountRole === 'OWNER' };
    }
    async list(query = '') {
        this.socket();
        if (typeof query !== 'string' || query.length > 200) throw new ChannelError('invalid_query');
        const channels = [], unavailable = [];
        const ids = [...this.known].slice(0, 100);
        const fold = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        for (const id of ids) {
            try {
                const channel = await this.get(id);
                if (!query || fold(channel.name).includes(fold(query.trim()))) channels.push(channel);
            } catch (_) { unavailable.push(id); }
        }
        return { success: true, channels, inventory_complete: false, inventory_source: 'observed_session_and_metadata_lookups',
            truncated: this.known.size > 100, unavailable_count: unavailable.length,
            limitation: 'Baileys 7.0.0-rc.2 non enumera tutti i canali. Catalogo in memoria: eventi osservati dalla sessione e ID consultati; si ricostruisce dopo un riavvio.' };
    }
    async send(id, message, imageUrl) {
        this.socket(id);
        if (typeof message !== 'string' || [...message].length > 16000 || (!imageUrl && !message.trim())) throw new ChannelError('invalid_message');
        if (imageUrl !== undefined) {
            let url;
            try { url = new URL(imageUrl); } catch (_) { throw new ChannelError('invalid_image_url'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ChannelError('invalid_image_url');
        }
        const channel = await this.get(id);
        if (!channel.can_publish) throw new ChannelError(channel.account_role === 'UNKNOWN' ? 'channel_role_unknown' : 'channel_not_admin', 403);
        let imageBuffer;
        if (imageUrl) {
            try { imageBuffer = (await this.download(imageUrl, {
                timeoutMs: Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS) || 10000,
                maxBytes: Number(process.env.MEDIA_MAX_BYTES) || 10 * 1024 * 1024
            })).buffer; } catch (error) { throw new ChannelError(error.code || 'media_failed', 424); }
        }
        const sock = this.socket(id);
        try {
            // Exactly one call. Native Baileys branches on @newsletter and uploads raw newsletter media.
            const result = await sock.sendMessage(id, imageUrl ? { image: imageBuffer, caption: message } : { text: message, linkPreview: null });
            return { success: true, channel_id: id, recipient: id, messageId: result?.key?.id || null,
                queued: false, delivery_status: 'submitted',
                note: 'Accettato dal trasporto Baileys; non è una conferma di pubblicazione o lettura. Nessun retry.' };
        } catch (_) {
            return { success: false, channel_id: id, recipient: id, messageId: null, queued: false,
                delivery_status: 'unknown', error: 'channel_send_unconfirmed',
                note: 'Esito ambiguo: potrebbe essere stato pubblicato. Non ripetere automaticamente.' };
        }
    }
}
module.exports = { ChannelService, ChannelError, CHANNEL };
