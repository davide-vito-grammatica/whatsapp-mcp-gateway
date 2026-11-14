const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('../config/swagger');
const configLoader = require('../config/config-loader');
const baileysClient = require('../client/baileys-client');
const { log, expressMiddleware } = require('../utils/logger');
const GroupService = require('../services/group-service');
const Outbox = require('../services/outbox');
const { downloadMedia } = require('../services/media-download');

const app = express();
app.set('case sensitive routing', true);
const mediaOptions = { timeoutMs: Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS) || 10000, maxBytes: Number(process.env.MEDIA_MAX_BYTES) || 10 * 1024 * 1024 };
const deadLetterQueue = new Outbox({ mediaOptions });
const connected = () => baileysClient.getStatus().status === 'connected';
let directInflight = 0;
const directLimit = Math.min(Math.max(Number(process.env.OUTBOX_CONCURRENCY) || 2, 1), 10);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 8, parts: 9, fieldSize: 65536 }
});
// Carica la porta dalla configurazione, con fallback alle variabili d'ambiente e default
const PORT = process.env.PORT || configLoader.getServerPort();

async function sendQueuedMessage(payload) {
    return baileysClient.sendMessage(payload.to, payload.message || '', payload.imageUrl || null, {
        ephemeral: payload.ephemeral,
        expiration: payload.expiration,
        attachmentUrl: payload.attachmentUrl,
        attachmentFileName: payload.attachmentFileName,
        attachmentMimeType: payload.attachmentMimeType,
        attachmentBuffer: payload.attachmentBuffer,
        imageBuffer: payload.imageBuffer
    });
}

async function retryDeadLetterQueue(force = false) {
    const result = await deadLetterQueue.retryPending(sendQueuedMessage, { isConnected: connected });
    if (result.sent || result.failed) {
        log.server('Replay dead letter queue completato', result);
    }
    return result;
}

baileysClient.setConnectionRestoredHandler(() => retryDeadLetterQueue());
setInterval(() => { if (connected()) retryDeadLetterQueue().catch(() => log.error('Outbox worker failed')); }, 30000).unref?.();

async function deliverOrQueue(payload, policy = 'required') {
    if (!['required', 'optional', 'deferred'].includes(policy)) throw Object.assign(new Error('invalid_media_policy'), { status: 400, code: 'invalid_media_policy' });
    if (policy === 'optional' && !payload.message) throw Object.assign(new Error('optional_requires_text'), { status: 400, code: 'optional_requires_text' });
    const url = payload.imageUrl || payload.attachmentUrl;
    if (url) {
        try {
            const media = await downloadMedia(url, { ...mediaOptions, image: !!payload.imageUrl });
            if (payload.imageUrl) payload.imageBuffer = media.buffer;
            else payload.attachmentBuffer = media.buffer;
            payload.imageUrl = null; payload.attachmentUrl = null;
        } catch (error) {
            let host = 'invalid';
            try { host = new URL(url).hostname; } catch (_) {}
            log.whatsapp('Media download failed', { code: /^media_[a-z0-9_]+$/.test(error.code || '') ? error.code : 'media_failed', host, kind: payload.imageUrl ? 'image' : 'attachment' });
            if (policy === 'optional' && payload.message && !['media_target_denied', 'media_invalid_url'].includes(error.code)) { payload.imageUrl = null; payload.attachmentUrl = null; payload.mediaFallback = true; }
            else if (policy === 'deferred' && error.temporary) {
                const queued = await deadLetterQueue.enqueue(payload, { mediaPolicy: policy });
                return { queued: true, queueId: queued.id, mediaAcquired: false };
            } else throw Object.assign(new Error(error.code || 'media_failed'), { status: 424, code: error.code || 'media_failed' });
        }
    }
    if (!connected()) {
        const queued = await deadLetterQueue.enqueue(payload, { mediaPolicy: policy });
        return { queued: true, queueId: queued.id, mediaAcquired: !!(payload.imageBuffer || payload.attachmentBuffer) };
    }
    if (directInflight >= directLimit) throw Object.assign(new Error('delivery_busy'), { status: 503, code: 'delivery_busy' });
    directInflight++;
    const sending = Promise.resolve().then(() => sendQueuedMessage(payload)).finally(() => { directInflight--; });
    let timer;
    try {
        const result = await Promise.race([sending, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('delivery_unconfirmed')), Number(process.env.OUTBOX_SEND_TIMEOUT_MS) || 30000);
        })]);
        return { result, mediaFallback: !!payload.mediaFallback };
    } catch (_) { throw Object.assign(new Error('delivery_unconfirmed'), { status: 502, unknown: true }); }
    finally { clearTimeout(timer); }
}
function sendFailure(res, error) {
    const code = error.code === 'outbox_capacity' ? 503 : error.status || 500;
    return res.status(code).json({ success: false, queued: false,
        delivery_status: error.unknown ? 'unknown' : 'not_sent', error: error.code || (error.unknown ? 'delivery_unconfirmed' : 'delivery_failed') });
}
function queuedResponse(res, delivery) {
    return res.status(202).json({ success: false, queued: true, delivery_status: 'queued',
        queueId: delivery.queueId, mediaAcquired: delivery.mediaAcquired });
}

// Middleware
app.use(require('./access-control').accessControl(process.env));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
// Authenticate before parsing admin request bodies; sanitize parse errors there.
app.use('/admin/pairing', require('./pairing-routes')(baileysClient));
app.use(express.json({ limit: '128kb' }));
app.use((error, req, res, next) => {
    if (!error) return next();
    res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'payload_too_large' : 'invalid_json' });
});

// Middleware per logging richieste
app.use(expressMiddleware);

// Dedicated channel routes: never enter the individual-recipient queue.
const { ChannelError } = require('../services/channel-service');
const channelRoute = operation => async (req, res) => {
    try { res.json(await operation(req)); }
    catch (error) {
        res.status(error instanceof ChannelError ? error.status : 500).json({
            success: false, queued: false, delivery_status: 'not_sent',
            error: error instanceof ChannelError ? error.code : 'channel_operation_failed'
        });
    }
};
// Existing API authentication is unchanged. New channel capabilities accept only
// the MCP peer on Docker DNS (or local read-only diagnostics), never forwarded IPs.
app.use('/channels', async (req, res, next) => {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (req.method === 'GET' && ['127.0.0.1', '::1'].includes(peer)) return next();
    try {
        const peers = await require('dns').promises.lookup('whatsapp-mcp', { all: true });
        if (peers.some(entry => entry.address === peer)) return next();
    } catch (_) { /* fail closed */ }
    return res.status(403).json({ success: false, error: 'channel_access_denied' });
});
app.get('/channels', channelRoute(req => baileysClient.channels.list(req.query.query || '')));
app.get('/channels/:id', channelRoute(async req => ({ success: true, channel: await baileysClient.channels.get(req.params.id) })));
app.post('/channels/send-message', channelRoute(req => baileysClient.channels.send(
    req.body.channel_id, req.body.message, req.body.imageUrl)));

// --- OpenAPI/Swagger Documentation ---
// Prima serviamo i file statici di Swagger UI
app.use('/api-docs', swaggerUi.serve);

// Middleware personalizzato per generare Swagger dinamicamente
app.get('/api-docs', (req, res, next) => {
    // Genera la configurazione Swagger dinamicamente basata sulla richiesta
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    // Determina la descrizione del server in base all'IP
    let serverDescription = 'Server locale';
    const ip = host.split(':')[0]; // Rimuovi la porta per controllare solo l'IP

    if (ip === 'localhost' || ip === '127.0.0.1') {
        serverDescription = 'Server di sviluppo locale';
    } else if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
        serverDescription = 'Server di produzione (rete locale)';
    } else {
        serverDescription = 'Server di produzione';
    }

    // Crea una copia della configurazione Swagger e aggiorna i server
    const dynamicSwaggerSpecs = JSON.parse(JSON.stringify(swaggerSpecs));
    dynamicSwaggerSpecs.servers = [
        {
            url: baseUrl,
            description: serverDescription,
        }
    ];

    // Aggiorna anche l'URL di contatto
    dynamicSwaggerSpecs.info.contact.url = baseUrl;

    // Serve Swagger UI con la configurazione dinamica
    const swaggerUiHandler = swaggerUi.setup(dynamicSwaggerSpecs, {
        explorer: true,
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'WhatsApp Proxy API Documentation'
    });

    swaggerUiHandler(req, res, next);
});

// Serve i file statici di Swagger UI
// app.use('/api-docs', swaggerUi.serve); // Spostato sopra

// Endpoint per le specifiche JSON (per debug) - anche questo dinamico
app.get('/api-docs.json', (req, res) => {
    // Genera la configurazione Swagger dinamicamente basata sulla richiesta
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    // Determina la descrizione del server in base all'IP
    let serverDescription = 'Server locale';
    const ip = host.split(':')[0];

    if (ip === 'localhost' || ip === '127.0.0.1') {
        serverDescription = 'Server di sviluppo locale';
    } else if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
        serverDescription = 'Server di produzione (rete locale)';
    } else {
        serverDescription = 'Server di produzione';
    }

    // Crea una copia della configurazione Swagger e aggiorna i server
    const dynamicSwaggerSpecs = JSON.parse(JSON.stringify(swaggerSpecs));
    dynamicSwaggerSpecs.servers = [
        {
            url: baseUrl,
            description: serverDescription,
        }
    ];

    // Aggiorna anche l'URL di contatto
    dynamicSwaggerSpecs.info.contact.url = baseUrl;

    res.setHeader('Content-Type', 'application/json');
    res.send(dynamicSwaggerSpecs);
});

// Redirect root to documentation
app.get('/', (req, res) => {
    res.redirect('/api-docs');
});

// --- API Endpoints ---

/**
 * @swagger
 * /status:
 *   get:
 *     summary: Ottieni stato connessione WhatsApp
 *     description: |
 *       Restituisce lo stato attuale della connessione WhatsApp.
 *       Se la connessione è in corso, include il QR code da scansionare.
 *     tags:
 *       - Connessione
 *     responses:
 *       200:
 *         description: Stato connessione recuperato con successo
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StatusResponse'
 *             examples:
 *               connected:
 *                 summary: Cliente connesso
 *                 value:
 *                   status: "connected"
 *                   message: "Client connesso!"
 *                   authFiles: "present"
 *                   connectionFailures: 0
 *               connecting:
 *                 summary: In attesa di QR code
 *                 value:
 *                   status: "connecting"
 *                   message: "In attesa di scansione QR. Controlla la console."
 *                   qr_code_raw: "data:image/png;base64,..."
 *                   authFiles: "missing"
 *                   connectionFailures: 0
 *               disconnected:
 *                 summary: Client disconnesso
 *                 value:
 *                   status: "disconnected"
 *                   message: "Non connesso"
 *                   authFiles: "present"
 *                   connectionFailures: 1
 */
// Endpoint per lo stato e per ottenere il QR code
app.get('/status', (req, res) => {
    const status = baileysClient.getStatus();
    const qr = baileysClient.getQRCode();

    if (status.status === 'connecting' && qr) {
        log.server('📱 QR Code richiesto via API...');
        res.json({
            status: 'connecting',
            diagnostic: status.diagnostic,
            message: 'In attesa di scansione QR. Controlla la console.',
            qr_code_available: true,
            sessionErrors: baileysClient.sessionErrorCount || 0,
            lastSessionReset: baileysClient.lastSessionReset || 0,
            sessionConfig: {
                maxSessionErrors: baileysClient.maxSessionErrors || 5,
                resetCooldownMinutes: (baileysClient.sessionResetCooldown || 300000) / 60000,
                autoRecoveryEnabled: baileysClient.autoRecoveryEnabled !== false
            }
        });
    } else {
        const now = Date.now();
        const timeSinceLastReset = baileysClient.lastSessionReset > 0
            ? Math.round((now - baileysClient.lastSessionReset) / 1000)
            : null;

        res.json({
            status: status.status,
            diagnostic: status.diagnostic,
            message: status.status === 'connected' ? 'Client connesso!' : 'Non connesso',
            sessionErrors: baileysClient.sessionErrorCount || 0,
            lastSessionReset: baileysClient.lastSessionReset || 0,
            timeSinceLastReset: timeSinceLastReset,
            sessionHealth: baileysClient.sessionErrorCount < baileysClient.maxSessionErrors ? 'good' : 'critical',
            sessionConfig: {
                maxSessionErrors: baileysClient.maxSessionErrors || 5,
                resetCooldownMinutes: (baileysClient.sessionResetCooldown || 300000) / 60000,
                autoRecoveryEnabled: baileysClient.autoRecoveryEnabled !== false
            }
        });
    }
});

/**
 * @swagger
 * /connection-monitor:
 *   get:
 *     summary: Ottieni statistiche del monitor di connessione
 *     description: |
 *       Restituisce le statistiche del sistema di monitoraggio della connessione WhatsApp,
 *       inclusi i tempi di connessione, disconnessioni e notifiche email inviate.
 *     tags:
 *       - Monitoraggio
 *     responses:
 *       200:
 *         description: Statistiche del monitor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 monitoring:
 *                   type: boolean
 *                   description: Se il monitoraggio è attivo
 *                 connected:
 *                   type: boolean
 *                   description: Stato attuale della connessione
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *                   description: Ultimo aggiornamento dello stato
 *                 connectionDuration:
 *                   type: number
 *                   description: Durata della connessione corrente in millisecondi
 *                 totalNotifications:
 *                   type: number
 *                   description: Numero totale di notifiche email inviate
 *                 lastNotification:
 *                   type: string
 *                   format: date-time
 *                   description: Timestamp dell'ultima notifica inviata
 */
app.get('/connection-monitor', (req, res) => {
    try {
        const monitorStats = baileysClient.getConnectionMonitorStatus();
        res.json(monitorStats);
    } catch (error) {
        log.error('Error getting connection monitor status:', error);
        res.status(500).json({
            error: 'Failed to get connection monitor status',
            message: error.message
        });
    }
});

/**
 * @swagger
 * /qr-code:
 *   get:
 *     summary: Visualizza QR Code per connessione WhatsApp
 *     description: |
 *       Restituisce una pagina HTML con il QR code da scansionare per connettere WhatsApp.
 *       Disponibile solo quando la connessione è in stato "connecting".
 *     tags:
 *       - Connessione
 *     responses:
 *       200:
 *         description: Pagina HTML con QR code
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: QR code non disponibile (già connesso o non in connessione)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "QR code non disponibile"
 *                 status:
 *                   type: string
 *                   example: "connected"
 */
// Shared management UI; existing QR availability/404 contract is preserved.
const linkPage = fs.readFileSync(path.join(__dirname, 'public/link.html'), 'utf8');
const renderLinkPage = qr => linkPage.replace('__QR_IMAGE__', qr || '');
app.get('/session/link', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(renderLinkPage(null));
});
app.get('/session/link.js', (req, res) => res.sendFile(path.join(__dirname, 'public/link.js')));
app.get('/qr-code', (req, res) => {
    const status = baileysClient.getStatus();
    const qrImage = baileysClient.getQRCodeImage();
    res.set('Cache-Control', 'no-store');
    if (status.status === 'connecting' && qrImage) {
        return res.type('html').send(renderLinkPage(qrImage));
    }
    // Browser navigation always has a useful management page, while JSON/API
    // consumers keep the existing unavailable-QR response contract.
    if (req.get('accept')?.includes('text/html')) return res.redirect(303, '/session/link');
    res.status(404).json({
        error: 'QR code non disponibile', status: status.status,
        message: status.status === 'connected' ? 'WhatsApp già connesso' :
            'Connessione non in corso. Apri /session/link per verificare lo stato.'
    });
});

/**
 * @swagger
 * /send-message:
 *   post:
 *     summary: Invia messaggio WhatsApp (individuale o gruppo)
 *     description: |
 *       Invia un messaggio di testo, un'immagine con caption o un allegato a un numero WhatsApp
 *       o a un gruppo. Il sistema riconosce automaticamente il tipo di destinatario:
 *
 *       **Destinatari supportati:**
 *       - Numero individuale: "390000000000" (formato internazionale)
 *       - Gruppo: "120363000000000000@g.us" (ID gruppo completo)
 *
 *       **Modalità supportate:**
 *       - Solo testo: Invia solo il campo `message`
 *       - Immagine con caption: Invia `imageUrl` + `message` (come caption)
 *       - Solo immagine: Invia `imageUrl` senza `message`
 *       - Allegato (PDF o altro documento): Invia `attachmentUrl`; `message` diventa la caption
 *
 *       **Validazioni automatiche:**
 *       - Numeri individuali: verifica esistenza su WhatsApp
 *       - Gruppi: verifica appartenenza e permessi di invio
 *     tags:
 *       - Messaggi
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: ['to']
 *             properties:
 *               to:
 *                 type: string
 *                 description: |
 *                   Destinatario del messaggio:
 *                   - Numero individuale (es. 390000000000)
 *                   - ID gruppo (es. 120363000000000000@g.us)
 *                 examples:
 *                   - "390000000000"
 *                   - "120363000000000000@g.us"
 *               message:
 *                 type: string
 *                 description: Testo del messaggio o caption per immagine
 *                 example: "Ciao! Come stai?"
 *               imageUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL dell'immagine da inviare
 *                 example: "https://picsum.photos/800/600"
 *               attachmentUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL del documento/allegato da inviare. Non usare insieme a imageUrl.
 *                 example: "https://example.com/documenti/preventivo.pdf"
 *               attachmentFileName:
 *                 type: string
 *                 description: Nome file mostrato su WhatsApp. Se omesso, viene ricavato dall'URL.
 *                 example: "preventivo.pdf"
 *               attachmentMimeType:
 *                 type: string
 *                 description: MIME type dell'allegato. Se omesso usa application/octet-stream.
 *                 example: "application/pdf"
 *           examples:
 *             text_individual:
 *               summary: Testo a numero individuale
 *               value:
 *                 to: "390000000000"
 *                 message: "Ciao! Come stai?"
 *             text_group:
 *               summary: Testo a gruppo
 *               value:
 *                 to: "120363000000000000@g.us"
 *                 message: "Ciao a tutti! 👋"
 *             image_group:
 *               summary: Immagine con caption a gruppo
 *               value:
 *                 to: "120363000000000000@g.us"
 *                 message: "Guardate questa bella foto! 📸"
 *                 imageUrl: "https://picsum.photos/800/600"
 *             image_individual:
 *               summary: Immagine a numero individuale
 *               value:
 *                 to: "390000000000"
 *                 message: "Foto per te!"
 *                 imageUrl: "https://picsum.photos/800/600"
 *             pdf_individual:
 *               summary: PDF con caption a numero individuale
 *               value:
 *                 to: "390000000000"
 *                 message: "Trovi il preventivo in allegato."
 *                 attachmentUrl: "https://example.com/documenti/preventivo.pdf"
 *                 attachmentFileName: "preventivo.pdf"
 *                 attachmentMimeType: "application/pdf"
 *     responses:
 *       200:
 *         description: Messaggio inviato con successo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 messageId:
 *                   type: string
 *                 to:
 *                   type: string
 *                 messageType:
 *                   type: string
 *                   enum: [individual, group]
 *                 contentType:
 *                   type: string
 *                   enum: [text, image, attachment]
 *                 hasImage:
 *                   type: boolean
 *                 targetInfo:
 *                   type: object
 *                   description: Informazioni sul destinatario
 *             examples:
 *               individual_success:
 *                 summary: Successo invio individuale
 *                 value:
 *                   success: true
 *                   message: "Messaggio inviato con successo"
 *                   messageId: "3EB0345A5674523EA3AA26"
 *                   to: "390000000000@s.whatsapp.net"
 *                   messageType: "individual"
 *                   contentType: "text"
 *                   hasImage: false
 *               group_success:
 *                 summary: Successo invio gruppo
 *                 value:
 *                   success: true
 *                   message: "Messaggio gruppo inviato con successo"
 *                   messageId: "3EB0345A5674523EA3BB27"
 *                   to: "120363000000000000@g.us"
 *                   messageType: "group"
 *                   contentType: "image"
 *                   hasImage: true
 *       400:
 *         description: Parametri mancanti o non validi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             examples:
 *               missing_params:
 *                 summary: Parametri mancanti
 *                 value:
 *                   error: "Parametri \"to\" e almeno uno tra \"message\", \"imageUrl\" o \"attachmentUrl\" sono obbligatori"
 *               group_permissions:
 *                 summary: Permessi gruppo insufficienti
 *                 value:
 *                   error: "Il gruppo \"Nome Gruppo\" è solo-annunci e non hai permessi admin"
 *       404:
 *         description: Destinatario non trovato
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             examples:
 *               number_not_found:
 *                 summary: Numero non registrato
 *                 value:
 *                   error: "Il numero 390000000000 non è registrato su WhatsApp"
 *               group_not_found:
 *                 summary: Gruppo non trovato
 *                 value:
 *                   error: "Gruppo non trovato o non sei membro"
 *       500:
 *         description: Errore durante l'invio
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             example:
 *               error: "Errore nell'invio del messaggio"
 *               details: "Client non connesso"
 */
// Endpoint per inviare messaggi (POST)
app.post('/send-message', async (req, res) => {
    const { to, message, imageUrl, attachmentUrl, attachmentFileName, attachmentMimeType, ephemeral, expiration, mediaPolicy = 'required' } = req.body;
    if (typeof to === 'string' && to.includes('@newsletter')) {
        return res.status(400).json({ error: 'Usare il percorso dedicato /channels/send-message per i canali.' });
    }
    if (!to || (!message && !imageUrl && !attachmentUrl)) {
        return res.status(400).json({
            error: 'Parametri "to" e almeno uno tra "message", "imageUrl" o "attachmentUrl" sono obbligatori'
        });
    }

    if (imageUrl && attachmentUrl) {
        return res.status(400).json({
            error: 'Specificare solo uno tra "imageUrl" e "attachmentUrl"'
        });
    }

    // Validazione messaggi effimeri opzionali
    let ephemeralOptions = {};
    if (ephemeral && expiration) {
        const validExpirations = [86400, 604800, 7776000];
        if (!validExpirations.includes(expiration)) {
            return res.status(400).json({
                error: 'Tempo di scadenza non valido',
                details: 'Utilizzare 86400 (24 ore), 604800 (7 giorni), o 7776000 (90 giorni)'
            });
        }
        ephemeralOptions = { ephemeral: true, expiration };
    }

    const deliveryPayload = {
        to,
        message: message || '',
        imageUrl: imageUrl || null,
        attachmentUrl: attachmentUrl || null,
        attachmentFileName: attachmentFileName || null,
        attachmentMimeType: attachmentMimeType || null,
        ...ephemeralOptions
    };

    try {
        const delivery = await deliverOrQueue(deliveryPayload, mediaPolicy);
        if (delivery.queued) return queuedResponse(res, delivery);
        const result = delivery.result;
        const messageType = delivery.mediaFallback ? 'text' : attachmentUrl ? 'attachment' : (imageUrl ? 'image' : 'text');
        const confirmMessage = delivery.mediaFallback ? 'Media non disponibile: inviato solo il testo' : attachmentUrl
            ? (message ? 'Allegato con caption inviato con successo' : 'Allegato inviato con successo')
            : imageUrl
            ? (message ? 'Immagine con caption inviata con successo' : 'Immagine inviata con successo')
            : 'Messaggio inviato con successo';

        const responseData = {
            success: true,
            message: confirmMessage,
            messageId: result.key.id,
            to: to,
            messageType: messageType,
            hasImage: !!imageUrl && !delivery.mediaFallback,
            mediaFallback: delivery.mediaFallback,
            hasAttachment: !!attachmentUrl && !delivery.mediaFallback,
            attachmentFileName: attachmentFileName || null,
            attachmentMimeType: attachmentMimeType || null
        };

        // Aggiungi informazioni effimeri se applicabili
        if (ephemeral && expiration) {
            const durationText = expiration === 86400 ? '24 ore' :
                               expiration === 604800 ? '7 giorni' : '90 giorni';
            responseData.isEphemeral = true;
            responseData.expiration = expiration;
            responseData.durationText = durationText;
        }

        res.json(responseData);
    } catch (error) {
        return sendFailure(res, error);
    }
});

/**
 * @swagger
 * /send-message-upload:
 *   post:
 *     summary: Invia un allegato binario WhatsApp
 *     description: Carica e invia un documento senza renderlo disponibile tramite URL pubblico. Il file è conservato solo in memoria durante la richiesta (massimo 64 MB).
 *     tags:
 *       - Messaggi
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [to, attachment]
 *             properties:
 *               to:
 *                 type: string
 *                 description: Numero internazionale o ID gruppo
 *               message:
 *                 type: string
 *                 description: Caption opzionale dell'allegato
 *               attachment:
 *                 type: string
 *                 format: binary
 *                 description: File da inviare, ad esempio un PDF
 *               attachmentFileName:
 *                 type: string
 *                 description: Nome file opzionale da mostrare su WhatsApp
 *               attachmentMimeType:
 *                 type: string
 *                 description: MIME type opzionale; per un PDF usa application/pdf
 *     responses:
 *       200:
 *         description: Allegato inviato con successo
 *       400:
 *         description: Parametri o file mancanti/non validi
 */
app.post('/send-message-upload', upload.single('attachment'), async (req, res) => {
    const { to, message, attachmentFileName, attachmentMimeType, ephemeral, expiration } = req.body;
    const attachment = req.file;

    if (!to || !attachment || !attachment.buffer?.length) {
        return res.status(400).json({
            error: 'I parametri "to" e il file "attachment" sono obbligatori'
        });
    }

    let ephemeralOptions = {};
    if (ephemeral && expiration) {
        const validExpirations = [86400, 604800, 7776000];
        const parsedExpiration = Number(expiration);
        if (!validExpirations.includes(parsedExpiration)) {
            return res.status(400).json({
                error: 'Tempo di scadenza non valido',
                details: 'Utilizzare 86400 (24 ore), 604800 (7 giorni), o 7776000 (90 giorni)'
            });
        }
        ephemeralOptions = { ephemeral: true, expiration: parsedExpiration };
    }

    const deliveryPayload = {
        to,
        message: message || '',
        attachmentBuffer: attachment.buffer,
        attachmentFileName: attachmentFileName || attachment.originalname || 'allegato',
        attachmentMimeType: attachmentMimeType || attachment.mimetype || 'application/octet-stream',
        ...ephemeralOptions
    };

    try {
        const delivery = await deliverOrQueue(deliveryPayload);
        if (delivery.queued) return queuedResponse(res, delivery);
        const result = delivery.result;

        res.json({
            success: true,
            message: message ? 'Allegato con caption inviato con successo' : 'Allegato inviato con successo',
            messageId: result.key.id,
            to,
            messageType: 'attachment',
            hasAttachment: true,
            attachmentFileName: attachmentFileName || attachment.originalname || 'allegato',
            attachmentMimeType: attachmentMimeType || attachment.mimetype || 'application/octet-stream',
            attachmentSize: attachment.size
        });
    } catch (error) {
        return sendFailure(res, error);
    }
});

/**
 * @swagger
 * /dead-letter-queue:
 *   get:
 *     summary: Elenca i messaggi in attesa di ritrasmissione
 *     tags: [Dead letter queue]
 *     responses:
 *       200:
 *         description: Coda recuperata con successo
 */
app.get('/dead-letter-queue', async (req, res) => {
    try {
        const messages = await deadLetterQueue.summaries();
        res.json({ ...(await deadLetterQueue.counts()), messages });
    } catch (error) {
        res.status(500).json({ error: 'Errore recupero dead letter queue', details: error.message });
    }
});

/**
 * @swagger
 * /dead-letter-queue/retry:
 *   post:
 *     summary: Ritenta immediatamente tutti i messaggi in coda
 *     tags: [Dead letter queue]
 *     responses:
 *       200:
 *         description: Replay completato
 */
app.post('/dead-letter-queue/retry', async (req, res) => {
    try {
        res.json(await retryDeadLetterQueue(true));
    } catch (error) {
        res.status(500).json({ error: 'Errore replay dead letter queue', details: error.message });
    }
});

/**
 * @swagger
 * /send-ephemeral-message:
 *   post:
 *     summary: Invia un messaggio effimero (temporaneo)
 *     description: |
 *       Invia un messaggio che si auto-distrugge dopo un tempo specificato.
 *       Supporta messaggi di testo e immagini con caption.
 *       Tempi di scadenza supportati: 24 ore (86400s), 7 giorni (604800s), 90 giorni (7776000s).
 *     tags:
 *       - Messaggi Effimeri
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *             properties:
 *               to:
 *                 type: string
 *                 description: Numero destinatario o ID gruppo
 *                 example: "390000000000"
 *               message:
 *                 type: string
 *                 description: Testo del messaggio (richiesto se non c'è imageUrl)
 *                 example: "Questo messaggio si auto-distruggerà in 24 ore"
 *               imageUrl:
 *                 type: string
 *                 description: URL dell'immagine da inviare (opzionale)
 *                 example: "https://example.com/image.jpg"
 *               expiration:
 *                 type: number
 *                 description: Tempo di scadenza in secondi
 *                 enum: [86400, 604800, 7776000]
 *                 default: 86400
 *                 example: 86400
 *     responses:
 *       200:
 *         description: Messaggio effimero inviato con successo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 messageId:
 *                   type: string
 *                 to:
 *                   type: string
 *                 messageType:
 *                   type: string
 *                 hasImage:
 *                   type: boolean
 *                 isEphemeral:
 *                   type: boolean
 *                 expiration:
 *                   type: number
 *                 durationText:
 *                   type: string
 *             example:
 *               success: true
 *               message: "Messaggio effimero inviato con successo"
 *               messageId: "msg123"
 *               to: "390000000000"
 *               messageType: "text"
 *               hasImage: false
 *               isEphemeral: true
 *               expiration: 86400
 *               durationText: "24 ore"
 *       400:
 *         description: Parametri mancanti o non validi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             example:
 *               error: "Parametri non validi"
 *               details: "Tempo di scadenza non supportato"
 *       500:
 *         description: Errore interno del server
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             example:
 *               error: "Errore nell'invio del messaggio effimero"
 *               details: "Client non connesso"
 */
app.post('/send-ephemeral-message', async (req, res) => {
    const { to, message, imageUrl, expiration = 86400, mediaPolicy = 'required' } = req.body;

    if (!to || (!message && !imageUrl)) {
        return res.status(400).json({
            error: 'Parametri "to" e almeno uno tra "message" o "imageUrl" sono obbligatori'
        });
    }

    // Valida il tempo di scadenza
    const validExpirations = [86400, 604800, 7776000];
    if (!validExpirations.includes(expiration)) {
        return res.status(400).json({
            error: 'Tempo di scadenza non valido',
            details: 'Utilizzare 86400 (24 ore), 604800 (7 giorni), o 7776000 (90 giorni)'
        });
    }

    const deliveryPayload = {
        to,
        message: message || '',
        imageUrl: imageUrl || null,
        ephemeral: true,
        expiration
    };

    try {
        const delivery = await deliverOrQueue(deliveryPayload, mediaPolicy);
        if (delivery.queued) return queuedResponse(res, delivery);
        const result = delivery.result;
        const messageType = imageUrl && !delivery.mediaFallback ? 'image' : 'text';
        const confirmMessage = delivery.mediaFallback ? 'Media non disponibile: inviato solo il testo' : imageUrl
            ? (message ? 'Immagine effimera con caption inviata con successo' : 'Immagine effimera inviata con successo')
            : 'Messaggio effimero inviato con successo';

        const durationText = expiration === 86400 ? '24 ore' :
                           expiration === 604800 ? '7 giorni' : '90 giorni';

        res.json({
            success: true,
            message: confirmMessage,
            messageId: result.key.id,
            to: to,
            messageType: messageType,
            hasImage: !!imageUrl && !delivery.mediaFallback,
            mediaFallback: delivery.mediaFallback,
            isEphemeral: true,
            expiration: expiration,
            durationText: durationText
        });
    } catch (error) {
        return sendFailure(res, error);
    }
});

/**
 * @swagger
 * /groups/{groupId}/ephemeral:
 *   post:
 *     summary: Configura i messaggi effimeri per un gruppo
 *     description: |
 *       Abilita o disabilita i messaggi effimeri per un gruppo WhatsApp.
 *       Quando abilitati, tutti i messaggi nel gruppo si auto-distruggeranno dopo il tempo specificato.
 *     tags:
 *       - Gruppi
 *       - Messaggi Effimeri
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del gruppo WhatsApp
 *         example: "120363123456789012@g.us"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - expiration
 *             properties:
 *               expiration:
 *                 type: number
 *                 description: Tempo di scadenza in secondi (0 per disabilitare)
 *                 enum: [0, 86400, 604800, 7776000]
 *                 example: 86400
 *     responses:
 *       200:
 *         description: Impostazioni messaggi effimeri aggiornate con successo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 groupId:
 *                   type: string
 *                 ephemeralExpiration:
 *                   type: number
 *                 durationText:
 *                   type: string
 *                 message:
 *                   type: string
 *             example:
 *               success: true
 *               groupId: "120363123456789012@g.us"
 *               ephemeralExpiration: 86400
 *               durationText: "24 ore"
 *               message: "Messaggi effimeri impostati a: 24 ore"
 *       400:
 *         description: Parametri non validi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             example:
 *               error: "Tempo di scadenza non valido"
 *               details: "Utilizzare 0 (disabilita), 86400 (24 ore), 604800 (7 giorni), o 7776000 (90 giorni)"
 *       500:
 *         description: Errore interno del server
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *             example:
 *               error: "Errore nella configurazione messaggi effimeri"
 *               details: "Gruppo non trovato"
 */
app.post('/groups/:groupId/ephemeral', async (req, res) => {
    const { groupId } = req.params;
    const { expiration } = req.body;

    if (expiration === undefined || expiration === null) {
        return res.status(400).json({
            error: 'Parametro "expiration" obbligatorio',
            details: 'Specificare il tempo di scadenza in secondi'
        });
    }

    // Valida il tempo di scadenza
    const validExpirations = [0, 86400, 604800, 7776000];
    if (!validExpirations.includes(expiration)) {
        return res.status(400).json({
            error: 'Tempo di scadenza non valido',
            details: 'Utilizzare 0 (disabilita), 86400 (24 ore), 604800 (7 giorni), o 7776000 (90 giorni)'
        });
    }

    try {
        const result = await baileysClient.setGroupEphemeralSetting(groupId, expiration);
        res.json(result);
    } catch (error) {
        console.error('❌ Errore configurazione messaggi effimeri gruppo:', error.message);
        res.status(500).json({
            error: 'Errore nella configurazione messaggi effimeri',
            details: error.message
        });
    }
});

/**
 * @swagger
 * /test-message:
 *   get:
 *     summary: Invia un messaggio di test
 *     description: |
 *       Invia rapidamente un messaggio di test con timestamp attuale.
 *       Utile per verificare il funzionamento della connessione.
 *     tags:
 *       - Messaggi
 *     parameters:
 *       - in: query
 *         name: to
 *         required: true
 *         schema:
 *           type: string
 *           example: "390000000000"
 *         description: Numero destinatario obbligatorio, senza valore predefinito
 *       - in: query
 *         name: message
 *         schema:
 *           type: string
 *         description: Messaggio personalizzato (opzionale)
 *       - in: query
 *         name: imageUrl
 *         schema:
 *           type: string
 *           format: uri
 *         description: URL immagine di test (opzionale)
 *         example: "https://picsum.photos/400/300"
 *     responses:
 *       200:
 *         description: Messaggio di test inviato
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/MessageResponse'
 *                 - type: object
 *                   properties:
 *                     content:
 *                       type: string
 *                       description: Contenuto del messaggio inviato
 *             example:
 *               success: true
 *               message: "Messaggio di test inviato! 🎉"
 *               messageId: "3EB0345A5674523EA3AA26"
 *               to: "390000000000"
 *               content: "🧪 Test Baileys - 11/09/2025, 10:30:15"
 *       500:
 *         description: Errore durante l'invio del test
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Endpoint per inviare un messaggio di test (GET)
app.get('/test-message', async (req, res) => {
    const to = req.query.to;
    if (typeof to !== 'string' || !to.trim()) {
        return res.status(400).json({ success: false, error: 'Recipient required: specify to.' });
    }
    const message = req.query.message || `🧪 Test Baileys - ${new Date().toLocaleString('it-IT')}`;
    const imageUrl = req.query.imageUrl || null;

    try {
        const delivery = await deliverOrQueue({ to, message, imageUrl });
        if (delivery.queued) return queuedResponse(res, delivery);
        const result = delivery.result;
        const messageType = imageUrl ? 'image' : 'text';
        const confirmMessage = imageUrl
            ? 'Messaggio di test con immagine inviato! 🎉📸'
            : 'Messaggio di test inviato! 🎉';

        res.json({
            success: true,
            message: confirmMessage,
            messageId: result.key.id,
            to: to,
            content: message,
            messageType: messageType,
            hasImage: !!imageUrl,
            mediaAcquired: !!imageUrl
        });
    } catch (error) {
        return sendFailure(res, error);
    }
});

// === ENDPOINTS GRUPPI ===

/**
 * @swagger
 * /groups:
 *   get:
 *     summary: Lista tutti i gruppi WhatsApp
 *     description: |
 *       Restituisce la lista di tutti i gruppi WhatsApp di cui sei membro.
 *       Include informazioni come nome, numero partecipanti e permessi.
 *       La lista è cached per 5 minuti per prestazioni ottimali.
 *     tags:
 *       - Gruppi
 *     parameters:
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Forza aggiornamento cache gruppi
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Cerca gruppi per nome o descrizione
 *     responses:
 *       200:
 *         description: Lista gruppi recuperata con successo
 *       500:
 *         description: Errore nel recupero gruppi
 */
app.get('/groups', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const searchTerm = req.query.search;

        console.log(`📋 Richiesta lista gruppi (refresh: ${forceRefresh}, search: ${searchTerm || 'none'})`);

        let groups = await baileysClient.getGroups(forceRefresh);

        // Applica filtro di ricerca se specificato
        if (searchTerm) {
            groups = baileysClient.searchGroups(searchTerm);
            console.log(`🔍 Filtro ricerca applicato: ${groups.length} gruppi trovati`);
        }

        const cacheStats = baileysClient.getGroupsCacheStats();

        res.json({
            success: true,
            count: groups.length,
            groups: groups,
            cached: !forceRefresh && cacheStats.isValid,
            cacheStats: {
                ageMinutes: cacheStats.ageMinutes,
                isValid: cacheStats.isValid,
                lastUpdate: cacheStats.lastUpdate
            },
            searchApplied: !!searchTerm
        });
    } catch (error) {
        console.error('❌ Errore recupero gruppi:', error.message);
        res.status(500).json({
            error: 'Errore nel recupero dei gruppi',
            details: error.message
        });
    }
});

/**
 * @swagger
 * /groups/{groupId}/info:
 *   get:
 *     summary: Informazioni dettagliate gruppo
 *     description: Restituisce informazioni dettagliate di un gruppo specifico
 *     tags:
 *       - Gruppi
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *           example: "120363000000000000@g.us"
 *     responses:
 *       200:
 *         description: Informazioni gruppo
 *       404:
 *         description: Gruppo non trovato
 */
app.get('/groups/:groupId/info', async (req, res) => {
    try {
        const { groupId } = req.params;

        if (!GroupService.isGroupId(groupId)) {
            return res.status(400).json({
                error: 'ID gruppo non valido (deve terminare con @g.us)',
                provided: groupId
            });
        }

        console.log(`📋 Richiesta info gruppo: ${groupId}`);
        const groupInfo = await baileysClient.getGroupInfo(groupId);

        res.json({
            success: true,
            group: groupInfo
        });
    } catch (error) {
        console.error(`❌ Errore info gruppo ${req.params.groupId}:`, error.message);

        if (error.message.includes('non trovato')) {
            res.status(404).json({
                error: 'Gruppo non trovato o non sei membro',
                groupId: req.params.groupId
            });
        } else {
            res.status(500).json({
                error: 'Errore nel recupero informazioni gruppo',
                details: error.message
            });
        }
    }
});

/**
 * @swagger
 * /groups/refresh:
 *   post:
 *     summary: Aggiorna cache gruppi
 *     description: Forza l'aggiornamento della cache dei gruppi
 *     tags:
 *       - Gruppi
 *     responses:
 *       200:
 *         description: Cache aggiornata
 */
app.post('/groups/refresh', async (req, res) => {
    try {
        console.log('🔄 Richiesta refresh cache gruppi...');
        const groups = await baileysClient.getGroups(true);

        res.json({
            success: true,
            message: 'Cache gruppi aggiornata con successo',
            count: groups.length,
            refreshedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Errore refresh gruppi:', error.message);
        res.status(500).json({
            error: 'Errore nell\'aggiornamento cache gruppi',
            details: error.message
        });
    }
});

/**
 * @swagger
 * /session/reset:
 *   post:
 *     summary: Reset completo della sessione
 *     description: |
 *       Esegue un logout completo da WhatsApp e rimuove tutti i file di autenticazione.
 *       Dopo il reset sarà necessario scansionare nuovamente il QR code.
 *     tags:
 *       - Gestione Sessione
 *     responses:
 *       200:
 *         description: Sessione resettata con successo
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: "Sessione resettata completamente. Riconnessione..."
 *       500:
 *         description: Errore durante il reset
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Endpoint per reset sessione (logout + cancella auth)
app.post('/session/reset', async (req, res) => {
    console.log('🔄 Reset completo sessione richiesto...');
    try {
        await baileysClient.forceLogout();

        const authStateDir = path.join(__dirname, 'baileys_auth_info');
        if (fs.existsSync(authStateDir)) {
            fs.rmSync(authStateDir, { recursive: true, force: true });
            console.log('🗑️ Cartella autenticazione rimossa.');
        }

        res.json({ success: true, message: 'Sessione resettata completamente. Riconnessione...' });

        setTimeout(() => {
            console.log('🔄 Riconnessione automatica...');
            baileysClient.connect();
        }, 2000);

    } catch (error) {
        console.error('❌ Errore reset:', error.message);
        res.status(500).json({ error: 'Errore durante il reset', details: error.message });
    }
});

/**
 * @swagger
 * /session/reset-crypto:
 *   post:
 *     summary: Reset sessione per errori crittografici
 *     description: |
 *       Effettua un reset soft della sessione WhatsApp specifico per risolvere
 *       errori crittografici come "Over 2000 messages into the future".
 *       Non elimina completamente l'autenticazione ma ricarica la sessione.
 *     tags:
 *       - Sessione
 *     responses:
 *       200:
 *         description: Reset crittografico completato con successo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 sessionErrors:
 *                   type: number
 *                 lastReset:
 *                   type: string
 *             example:
 *               success: true
 *               message: "Reset crittografico completato"
 *               sessionErrors: 0
 *               lastReset: "2025-09-18T09:40:15.123Z"
 *       500:
 *         description: Errore durante il reset
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post('/session/reset-crypto', async (req, res) => {
    console.log('🔐 Reset crittografico sessione richiesto...');
    try {
        // Ottieni statistiche prima del reset
        const beforeStats = {
            sessionErrors: baileysClient.sessionErrorCount,
            lastReset: baileysClient.lastSessionReset
        };

        // Forza il reset per errori di sessione
        await baileysClient.resetSessionDueToErrors();

        const afterStats = {
            sessionErrors: baileysClient.sessionErrorCount,
            lastReset: new Date(baileysClient.lastSessionReset).toISOString()
        };

        console.log('✅ Reset crittografico completato');
        res.json({
            success: true,
            message: 'Reset crittografico completato. Sessione ricaricata.',
            sessionErrors: afterStats.sessionErrors,
            lastReset: afterStats.lastReset,
            resetTriggered: true
        });

    } catch (error) {
        console.error('❌ Errore reset crittografico:', error.message);
        res.status(500).json({
            error: 'Errore durante il reset crittografico',
            details: error.message
        });
    }
});

/**
 * @swagger
 * /session/logout:
 *   post:
 *     summary: Logout mantenendo autenticazione
 *     description: |
 *       Esegue il logout da WhatsApp ma mantiene i file di autenticazione
 *       per una riconnessione rapida senza QR code.
 *     tags:
 *       - Gestione Sessione
 *     responses:
 *       200:
 *         description: Logout completato
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: "Logout completato. Autenticazione mantenuta."
 *       500:
 *         description: Errore durante il logout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Endpoint per logout completo (mantiene auth per riconnessione rapida)
app.post('/session/logout', async (req, res) => {
    console.log('🚪 Logout completo richiesto...');
    try {
        await baileysClient.forceLogout();
        res.json({ success: true, message: 'Logout completato. Autenticazione mantenuta.' });
    } catch (error) {
        console.error('❌ Errore logout:', error.message);
        res.status(500).json({ error: 'Errore durante il logout', details: error.message });
    }
});

/**
 * @swagger
 * /session/clean-auth:
 *   post:
 *     summary: Pulizia file autenticazione corrotti
 *     description: |
 *       Rimuove manualmente i file di autenticazione corrotti e avvia
 *       automaticamente una nuova connessione con QR code fresco.
 *     tags:
 *       - Gestione Sessione
 *     responses:
 *       200:
 *         description: File puliti con successo
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             examples:
 *               cleaned:
 *                 summary: File rimossi
 *                 value:
 *                   success: true
 *                   message: "File autenticazione puliti. Riconnessione necessaria."
 *               no_files:
 *                 summary: Nessun file da pulire
 *                 value:
 *                   success: true
 *                   message: "Nessun file da pulire."
 *       500:
 *         description: Errore durante la pulizia
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Endpoint per pulizia manuale file corrotti
app.post('/session/clean-auth', async (req, res) => {
    console.log('🧹 Pulizia manuale file autenticazione richiesta...');
    try {
        const cleaned = await baileysClient.cleanCorruptedAuthFiles();
        if (cleaned) {
            res.json({ success: true, message: 'File autenticazione puliti. Riconnessione necessaria.' });
            // Avvia automaticamente una nuova connessione
            setTimeout(() => {
                console.log('🔄 Avvio automatico nuova connessione...');
                baileysClient.connect();
            }, 1000);
        } else {
            res.json({ success: true, message: 'Nessun file da pulire.' });
        }
    } catch (error) {
        console.error('❌ Errore pulizia:', error.message);
        res.status(500).json({ error: 'Errore durante la pulizia', details: error.message });
    }
});

/**
 * @swagger
 * /keepalive/status:
 *   get:
 *     summary: Stato sistema keep-alive
 *     description: |
 *       Restituisce lo stato attuale del sistema di keep-alive automatico,
 *       inclusa la configurazione e lo stato di esecuzione.
 *     tags:
 *       - Keep-Alive
 *     responses:
 *       200:
 *         description: Stato keep-alive recuperato
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/KeepAliveStatus'
 *             example:
 *               enabled: true
 *               running: false
 *               intervalMinutes: 30
 *               groupId: "120363000000000000@g.us"
 *               customMessage: "🤖 Keep-alive automatico - Sistema attivo"
 *               connectionStatus: "connected"
 *               connectionFailures: 0
 */
// Keep-Alive Endpoints
app.get('/keepalive/status', (req, res) => {
    const status = baileysClient.getKeepAliveStatus();
    res.json(status);
});

/**
 * @swagger
 * /keepalive/reload-config:
 *   post:
 *     summary: Ricarica configurazione keep-alive
 *     description: |
 *       Ricarica la configurazione dal file config.ini e riavvia
 *       il sistema keep-alive con i nuovi parametri.
 *     tags:
 *       - Keep-Alive
 *     responses:
 *       200:
 *         description: Configurazione ricaricata
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: "Configurazione ricaricata con successo"
 *       500:
 *         description: Errore nel ricaricare la configurazione
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post('/keepalive/reload-config', async (req, res) => {
    try {
        await baileysClient.reloadConfig();
        res.json({ success: true, message: 'Configurazione ricaricata con successo' });
    } catch (error) {
        console.error('❌ Errore ricarica config:', error.message);
        res.status(500).json({ error: 'Errore nel ricaricare la configurazione', details: error.message });
    }
});

/**
 * @swagger
 * /keepalive/send-now:
 *   post:
 *     summary: Invia keep-alive immediato
 *     description: |
 *       Invia immediatamente un messaggio keep-alive al gruppo configurato,
 *       indipendentemente dal timer automatico.
 *     tags:
 *       - Keep-Alive
 *     responses:
 *       200:
 *         description: Keep-alive inviato
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: "Messaggio keep-alive inviato"
 *       500:
 *         description: Errore nell'invio del keep-alive
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: "Errore nell'invio del keep-alive"
 *               details: "Client non connesso"
 */
app.post('/keepalive/send-now', async (req, res) => {
    try {
        await baileysClient.sendKeepAliveMessage();
        res.json({ success: true, message: 'Messaggio keep-alive inviato' });
    } catch (error) {
        console.error('❌ Errore keep-alive:', error.message);
        res.status(500).json({ error: 'Errore nell\'invio del keep-alive', details: error.message });
    }
});

/**
 * @swagger
 * /monitor/status:
 *   get:
 *     summary: Stato monitor connessione e notifiche email
 *     description: |
 *       Restituisce lo stato dettagliato del monitor di connessione WhatsApp
 *       e del sistema di notifiche email.
 *     tags:
 *       - Monitor
 *     responses:
 *       200:
 *         description: Stato monitor recuperato con successo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 connectionMonitor:
 *                   type: object
 *                   properties:
 *                     isConnected:
 *                       type: boolean
 *                       description: Se WhatsApp è attualmente connesso
 *                     connectionStatus:
 *                       type: string
 *                       description: Stato della connessione
 *                     lastConnectionTime:
 *                       type: string
 *                       format: date-time
 *                       description: Timestamp ultima connessione riuscita
 *                     disconnectedMinutes:
 *                       type: number
 *                       description: Minuti da quando disconnesso
 *                     timeoutThreshold:
 *                       type: number
 *                       description: Soglia timeout per alert (minuti)
 *                     alertSent:
 *                       type: boolean
 *                       description: Se è stato inviato un alert
 *                 emailSystem:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Se il sistema email è abilitato
 *                     emailCooldown:
 *                       type: object
 *                       properties:
 *                         inCooldown:
 *                           type: boolean
 *                         remainingMinutes:
 *                           type: number
 */
app.get('/monitor/status', (req, res) => {
    try {
        const monitorStatus = baileysClient.connectionMonitor.getStatus();
        const emailEnabled = baileysClient.emailNotifier.enabled;

        res.json({
            connectionMonitor: monitorStatus,
            emailSystem: {
                enabled: emailEnabled,
                emailCooldown: monitorStatus.emailCooldown
            }
        });
    } catch (error) {
        console.error('❌ Errore recupero status monitor:', error.message);
        res.status(500).json({
            error: 'Errore nel recupero dello status del monitor',
            details: error.message
        });
    }
});

// --- Avvio Server ---
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const large = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_PART_COUNT' || error.code === 'LIMIT_FIELD_VALUE';
    res.status(large ? 413 : 500).json({ error: large ? 'payload_too_large' : 'request_failed' });
});

const server = app.listen(PORT, () => {
    log.startup('WhatsApp Proxy Server (Baileys) avviato!', { port: PORT });
    log.server(`Server in ascolto sulla porta ${PORT}`, { port: PORT });

    log.server('Documentazione API disponibile:', {
        endpoints: {
            root: `http://localhost:${PORT}/`,
            docs: `http://localhost:${PORT}/api-docs`
        }
    });

    log.server('Endpoint principali configurati:', {
        status: `GET http://localhost:${PORT}/status`,
        sendMessage: `POST http://localhost:${PORT}/send-message`,
        testMessage: `GET http://localhost:${PORT}/test-message`
    });

    log.server('Gestione sessione:', {
        reset: `POST http://localhost:${PORT}/session/reset`,
        resetCrypto: `POST http://localhost:${PORT}/session/reset-crypto`,
        logout: `POST http://localhost:${PORT}/session/logout`,
        cleanAuth: `POST http://localhost:${PORT}/session/clean-auth`
    });

    log.server('Endpoint Keep-Alive:', {
        status: `GET http://localhost:${PORT}/keepalive/status`,
        reloadConfig: `POST http://localhost:${PORT}/keepalive/reload-config`,
        sendNow: `POST http://localhost:${PORT}/keepalive/send-now`
    });

    log.server('Monitor e Notifiche:', {
        monitor: `GET http://localhost:${PORT}/monitor/status`
    });

    log.whatsapp('Connessione a WhatsApp in corso...');
    log.startup('💡 Scannerizza il QR code quando appare per connetterti!');
});

// Avvia la connessione dopo che il server è up
setTimeout(() => {
    log.whatsapp('Inizializzazione connessione WhatsApp...');
    try {
        baileysClient.connect().catch(error => {
            log.error('Errore connessione Baileys', error);
        });
    } catch (syncError) {
        log.error('Errore sincrono durante connect()', syncError);
    }
}, 1000);

// Gestione graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Arresto server...');
    baileysClient.disconnect().finally(() => {
        console.log('👋 Server terminato.');
        process.exit(0);
    });
});
