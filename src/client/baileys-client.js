const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Per generare QR come immagini
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const ini = require('ini');
const { log, baileysLogger } = require('../utils/logger');
const EmailNotifier = require('../utils/email-notifier');
const ConnectionMonitor = require('../utils/connection-monitor');
const GroupService = require('../services/group-service');
const { ChannelService } = require('../services/channel-service');
const { PairingService } = require('../services/pairing-service');

// Lazy import di Baileys per evitare blocchi
let baileysModules = null;
function getBaileysModules() {
    if (!baileysModules) {
        baileysModules = require('@whiskeysockets/baileys');
    }
    return baileysModules;
}

// Path per salvare lo stato di autenticazione
const authStateDir = path.join(__dirname, '..', '..', 'data', 'auth');

class BaileysClient {
    constructor() {
        this.sock = null;
        this.pairing = new PairingService();
        this.reconnectTimer = null;
        this.reconnectAt = null;
        this.recoveryBlock = null;
        this.recoveryReason = null;
        this.connectionGeneration = 0;
        this.lastConnectionError = null;
        this.credentialWrites = Promise.resolve();
        this.channels = new ChannelService(this);
        this.isConnecting = false;
        this.qrCode = null;
        this.qrCodeImage = null; // QR code come immagine base64
        this.connectionStatus = 'disconnected';
        this.keepAliveInterval = null;
        this.config = this.loadConfig();
        this.reconnectAttempts = 0;
        this.connectionFailures = 0; // Contatore fallimenti consecutivi
        this.maxFailures = 2; // Soglia diagnostica; nessuna pulizia automatica
        this.lastFailureTime = 0; // Timestamp ultimo fallimento
        this.connectionMonitor = null; // Inizializzato dopo
        this.connectionRestoredHandler = null;

        // Contatori per gestione errori di sessione
        this.sessionErrorCount = 0;
        this.lastSessionReset = 0;

        // Configurazioni per gestione errori (da config.ini)
        this.maxSessionErrors = parseInt(this.config.session?.max_session_errors) || 5;
        this.sessionResetCooldown = (parseInt(this.config.session?.reset_cooldown_minutes) || 5) * 60 * 1000; // Converti in millisecondi
        this.autoRecoveryEnabled = this.config.session?.auto_recovery_enabled === 'true' || this.config.session?.auto_recovery_enabled === true;
    }

    setupSessionErrorHandling() {
        if (this.sessionErrorHandlingInstalled) return;
        this.sessionErrorHandlingInstalled = true;
        // Gestione errori SessionError a livello di processo
        const originalConsoleError = console.error;
        console.error = (...args) => {
            const message = args.join(' ');
            if (message.includes('SessionError') && message.includes('Over 2000 messages into the future')) {
                console.warn('🚨 RILEVATO ERRORE DI SESSIONE:', message);
                // Gestisci l'errore in modo asincrono
                setImmediate(async () => {
                    try {
                        await this.handleSessionError(new Error(message));
                    } catch (error) {
                        originalConsoleError('❌ Errore nella gestione del SessionError:', error);
                    }
                });
            }
            return originalConsoleError.apply(console, args);
        };
    }

    setConnectionRestoredHandler(handler) {
        this.connectionRestoredHandler = handler;
    }

    scheduleReconnect(reason, immediate = false) {
        if (this.recoveryBlock || this.sock || this.isConnecting || this.reconnectTimer) return;
        this.recoveryReason = reason;
        this.reconnectAttempts++;
        // Five quick attempts, then keep trying slowly instead of stranding a
        // recoverable session. Never delete/rewrite credentials to make it work.
        const delay = immediate ? 0 : this.reconnectAttempts > 5 ? 300000 :
            Math.min(3000 * (2 ** (this.reconnectAttempts - 1)), 60000) + Math.floor(Math.random() * 1000);
        this.reconnectAt = Date.now() + delay;
        const generation = this.connectionGeneration;
        this.reconnectTimer = setTimeout(async () => {
            if (generation !== this.connectionGeneration || this.recoveryBlock) return;
            this.reconnectTimer = null; this.reconnectAt = null;
            let writeTimer;
            try {
                await Promise.race([this.credentialWrites, new Promise((_, reject) => {
                    writeTimer = setTimeout(() => reject(new Error('credentials_write_timeout')), 30000);
                })]);
            } catch (_) {
                this.recoveryBlock = 'credentials_write_failed';
                this.lastConnectionError = 'credentials_write_failed';
                return;
            } finally { clearTimeout(writeTimer); }
            // A manual disconnect may have happened while writes were pending.
            if (generation !== this.connectionGeneration || this.recoveryBlock) return;
            try { await this.connect(); }
            catch (_) { this.scheduleReconnect('initialization_failed'); }
        }, delay);
        this.reconnectTimer.unref?.();
    }

    async connect() {
        if (this.sock || this.isConnecting) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null; this.reconnectAt = null; this.recoveryBlock = null;
        const generation = ++this.connectionGeneration;
        let timeout;
        try {
            return await Promise.race([this.connectInternal(generation), new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('initialization_timeout')), 30000);
            })]);
        } catch (error) {
            if (this.connectionGeneration === generation) {
                this.connectionGeneration++;
                const socket = this.sock;
                this.sock = null;
                if (socket) { this.pairing.update({ connection: 'close' }); try { socket.end(); } catch (_) {} }
                this.isConnecting = false;
                this.connectionStatus = 'disconnected';
                this.lastConnectionError = error.message === 'initialization_timeout' ? 'initialization_timeout' : 'initialization_failed';
                this.scheduleReconnect(this.lastConnectionError);
            }
            throw error;
        } finally { clearTimeout(timeout); }
    }

    async connectInternal(generation) {
        try {
            if (this.sock || this.isConnecting) {
                console.warn('Connection attempt ignored, already connecting or connected.');
                return;
            }

            // Carica i moduli Baileys quando necessario
            const baileys = getBaileysModules();
            const {
                default: makeWASocket,
                useMultiFileAuthState,
                DisconnectReason,
                fetchLatestBaileysVersion,
                fetchLatestWaWebVersion,
                jidNormalizedUser,
                Browsers
            } = baileys;

            console.log('🔄 Connessione WhatsApp in corso...');
            this.isConnecting = true;
            this.connectionStatus = 'connecting';

        // Inizializza il monitor se non esiste
        if (!this.connectionMonitor) {
            this.emailNotifier = new EmailNotifier(this.config);
            this.connectionMonitor = new ConnectionMonitor(this.emailNotifier, this.config);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authStateDir);
        if (generation !== this.connectionGeneration) return;
        // rc.2 persists me before phone acceptance. Such a pending pairing must
        // use a registration handshake, not a login with an unlinked identity.
        // Keep the persisted object/file intact until Baileys emits new creds.
        const incompletePairing = !state.creds.registered && !state.creds.account &&
            !!state.creds.pairingCode && !!state.creds.me &&
            !state.creds.me.id?.split('@')[0]?.includes(':');
        const socketState = incompletePairing ? {
            ...state, creds: { ...state.creds, me: undefined }
        } : state;
        // The Baileys repository's version can lag the deployed WhatsApp Web
        // client and silently break new-device linking (upstream #2679).
        let versionInfo;
        try { versionInfo = await fetchLatestWaWebVersion({ timeout: 10000 }); }
        catch (_) { /* use the existing source if WhatsApp cannot be queried */ }
        const webVersion = versionInfo?.isLatest && Array.isArray(versionInfo.version) &&
            versionInfo.version.length === 3 && versionInfo.version.every(Number.isInteger);
        if (!webVersion) versionInfo = await fetchLatestBaileysVersion({ timeout: 10000 });
        if (generation !== this.connectionGeneration) return;
        const { version, isLatest } = versionInfo;
        console.log(`📱 Baileys v${version} (latest: ${isLatest}, source: ${webVersion ? 'whatsapp-web' : 'baileys-fallback'})`);

        // Gestione errori SessionError a livello globale
        this.setupSessionErrorHandling();

        this.sock = makeWASocket({
            version,
            auth: socketState,
            printQRInTerminal: false, // Gestiremo QR manualmente
            logger: baileysLogger,
            // Code registration validates companion_platform_display. A product
            // name in the OS slot yields an unusable code with rc.2 (upstream #2769).
            // Preserve the existing profile for already authenticated credentials.
            browser: state.creds.registered || (state.creds.account && state.creds.me) ?
                ['MyWhatsAppProxy', 'Chrome', '1.0.0'] : Browsers.windows('Chrome'),
            generateHighQualityLinkPreview: true,
        });

        // Gestore per errori non catturati della socket
        if (this.sock.ws) {
            this.sock.ws.on('error', async (error) => {
                console.error('🌐 Errore WebSocket:', error.message);
                if (error.message && (
                    error.message.includes('SessionError') ||
                    error.message.includes('Over 2000 messages') ||
                    error.message.includes('Failed to decrypt')
                )) {
                    await this.handleSessionError(error);
                }
            });
        }

        // Per ora usiamo console.log negli event handlers per evitare problemi di scope
        const clientLogger = {
            info: console.log,
            warn: console.warn,
            error: console.error,
            debug: console.log
        };

        const socket = this.sock;
        this.pairing.attach(socket);
        this.socketWatchdog = setTimeout(() => {
            if (this.sock !== socket) return;
            this.lastConnectionError = 'socket_timeout';
            this.sock = null; this.isConnecting = false; this.connectionStatus = 'disconnected';
            this.qrCode = null; this.qrCodeImage = null;
            this.pairing.update({ connection: 'close' });
            try { socket.end(); } catch (_) {}
            this.scheduleReconnect('socket_timeout');
        }, 45000);
        // rc.2's native requestPairingCode only awaits sendNode, not the server
        // reply. Observe numeric IQ errors while an unregistered pairing is active.
        socket.ws?.on('CB:iq,type:error', node => {
            if (this.sock === socket && this.pairing.observeRegistrationError(node)) {
                clientLogger.warn(`WhatsApp pairing IQ error: ${this.pairing.lastError.code}`);
            }
        });
        this.channels.observe(socket);
        this.sock.ev.on('creds.update', () => {
            if (this.sock !== socket) return;
            this.credentialWrites = this.credentialWrites.catch(() => {}).then(async () => {
                if (socketState !== state) Object.assign(state.creds, socketState.creds);
                await saveCreds();
            });
            // Keep the rejection observable to reconnect, without an unhandled promise.
            this.credentialWrites.catch(() => { this.lastConnectionError = 'credentials_write_failed'; clientLogger.error('Salvataggio credenziali fallito.'); });
        });

        this.sock.ev.on('connection.update', async (update) => {
            if (this.sock !== socket) return; // Ignore events from retired sockets.
            const { connection, lastDisconnect, qr } = update;
            this.pairing.update(update);
            if (qr || connection === 'open' || connection === 'close') clearTimeout(this.socketWatchdog);
            if (qr) { this.qrCode = qr; this.qrCodeImage = null; }
            if (update.isNewLogin) { this.qrCode = null; this.qrCodeImage = null; }

            // Logging dello stato di connessione
            if (connection) {
                clientLogger.info(`🔗 Stato connessione: ${connection}`);
                this.connectionStatus = connection;
                // Notifica il monitor del cambio di stato
                if (this.connectionMonitor) {
                    this.connectionMonitor.updateConnectionStatus(connection);
                }
            }

            if (qr) {
                clientLogger.info('📱 QR CODE - Scansiona con WhatsApp:');
                qrcode.generate(qr, { small: true });
                clientLogger.info('✨ Dopo la scansione, la connessione sarà automatica!');
                clientLogger.info('🌐 QR Code disponibile anche su: http://localhost:3000/qr-code');

                // Genera QR code come immagine
                try {
                    const image = await QRCode.toDataURL(qr, {
                        width: 300,
                        margin: 2,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    if (this.sock === socket && this.qrCode === qr) this.qrCodeImage = image;
                } catch (error) {
                    clientLogger.error('❌ Errore generazione QR code immagine:', error);
                    if (this.sock === socket && this.qrCode === qr) this.qrCodeImage = null;
                }
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                // 500 can be transient even with usable retained credentials.
                // Retry non-destructively; revoked/conflicting sessions stay blocked.
                const shouldReconnect = ![DisconnectReason.loggedOut,
                    DisconnectReason.connectionReplaced,
                    DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(reason);

                // Reset dello stato di connessione
                this.connectionStatus = 'disconnected';
                this.isConnecting = false;
                this.sock = null;
                this.qrCode = null;
                this.qrCodeImage = null;

                // Ferma il keep-alive
                this.stopKeepAlive();

                const errorMessage = lastDisconnect?.error?.message || 'Errore sconosciuto';
                clientLogger.error(`Connection closed due to: ${lastDisconnect?.error?.output?.statusCode || 'transport'}, reconnecting: ${shouldReconnect}`);
                clientLogger.warn('Connessione chiusa; verifica lo stato amministrativo.');

                // Conta i fallimenti senza modificare i file di autenticazione
                const isConnectionFailure = errorMessage.includes('Connection Failure') ||
                                          errorMessage.includes('Connection Error') ||
                                          errorMessage.includes('Timed Out');

                if (isConnectionFailure) {
                    this.connectionFailures++;
                    this.lastFailureTime = Date.now();
                    clientLogger.warn(`⚠️ Fallimento connessione ${this.connectionFailures}/${this.maxFailures}`);

                } else {
                    // Reset counter per altri tipi di errore
                    this.connectionFailures = 0;
                }

                if (shouldReconnect) {
                    this.scheduleReconnect(Number.isInteger(reason) ? reason : 'transport',
                        reason === DisconnectReason.restartRequired);
                } else {
                    this.recoveryBlock = reason === DisconnectReason.connectionReplaced ?
                        'connection_replaced' : 'session_rejected';
                    if (this.lastConnectionError !== 'credentials_write_failed') this.lastConnectionError = this.recoveryBlock;
                    clientLogger.warn('Autenticazione interrotta; credenziali conservate. Verifica amministrativa necessaria.');
                }
            } else if (connection === 'connecting') {
                this.connectionStatus = 'connecting';
                clientLogger.info('🔄 Connessione in corso...');
            } else if (connection === 'open') {
                this.connectionStatus = 'connected';
                this.lastConnectionError = null;
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null; this.reconnectAt = null;
                this.recoveryBlock = null; this.recoveryReason = null;
                this.isConnecting = false;
                this.qrCode = null; // QR non più necessario
                this.qrCodeImage = null; // QR immagine non più necessaria
                this.connectionFailures = 0; // Reset counter su connessione riuscita
                this.reconnectAttempts = 0;
                clientLogger.info('🎉 WhatsApp connesso con successo!');

                // Avvia il monitor di connessione ora che siamo connessi
                if (this.connectionMonitor) {
                    this.connectionMonitor.start();
                }

                // Avvia il keep-alive se abilitato
                this.startKeepAlive();

                // Riproduce i messaggi in coda solo dopo che Baileys ha riaperto la sessione.
                if (this.connectionRestoredHandler) {
                    setImmediate(() => {
                        Promise.resolve(this.connectionRestoredHandler()).catch((error) => {
                            console.error('❌ Errore replay dead letter queue:', error.message);
                        });
                    });
                }

                // Invia messaggio di avvio
                setTimeout(() => {
                    this.sendStartupMessage();
                }, 2000); // Aspetta 2 secondi per essere sicuri che la connessione sia stabile
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            try {
                // Segnala attività WhatsApp per reset timeout
                if (this.connectionMonitor) {
                    this.connectionMonitor.updateLastActivity();
                }

                const messages = m.messages || [];

                for (const msg of messages) {
                    // Ignora messaggi di protocollo o di sistema
                    if (!msg.message || msg.key.fromMe === undefined) continue;

                    // Estrae il contenuto del messaggio con supporto per vari tipi
                    let messageContent = '';
                    let messageType = 'text';

                if (msg.message.conversation) {
                    messageContent = msg.message.conversation;
                } else if (msg.message.extendedTextMessage?.text) {
                    messageContent = msg.message.extendedTextMessage.text;
                } else if (msg.message.imageMessage) {
                    messageContent = msg.message.imageMessage.caption || '[Immagine]';
                    messageType = 'image';
                } else if (msg.message.videoMessage) {
                    messageContent = msg.message.videoMessage.caption || '[Video]';
                    messageType = 'video';
                } else if (msg.message.documentMessage) {
                    messageContent = `[Documento: ${msg.message.documentMessage.fileName || 'Sconosciuto'}]`;
                    messageType = 'document';
                } else if (msg.message.audioMessage) {
                    messageContent = '[Messaggio audio]';
                    messageType = 'audio';
                } else if (msg.message.contactMessage) {
                    messageContent = `[Contatto: ${msg.message.contactMessage.displayName || 'Sconosciuto'}]`;
                    messageType = 'contact';
                } else if (msg.message.locationMessage) {
                    messageContent = '[Posizione]';
                    messageType = 'location';
                } else {
                    messageContent = '[Messaggio non supportato]';
                    messageType = 'unsupported';
                }

                // Formatta il timestamp
                const timestamp = new Date(msg.messageTimestamp * 1000);
                const timeString = timestamp.toLocaleString('it-IT');

                // Estrae informazioni sul contatto
                const contactInfo = this.formatContactInfo(msg.key.remoteJid);

                if (msg.key.fromMe) {
                    // ===== MESSAGGIO INVIATO DA NOI =====
                    console.log('📤 MESSAGGIO INVIATO:');
                    console.log(`├─ Destinatario: ${contactInfo.displayName}`);
                    console.log(`├─ Numero: ${contactInfo.phoneNumber}`);
                    console.log(`├─ Tipo: ${messageType.toUpperCase()}`);
                    console.log(`├─ Contenuto: ${messageContent}`);
                    console.log(`├─ ID Messaggio: ${msg.key.id}`);
                    console.log(`└─ Timestamp: ${timeString}`);

                    // Log strutturato per messaggio inviato
                    log.whatsapp('Message sent via WhatsApp', {
                        direction: 'outgoing',
                        messageType,
                        to: msg.key.remoteJid,
                        toFormatted: contactInfo.displayName,
                        content: messageContent,
                        messageId: msg.key.id,
                        timestamp: timestamp.toISOString(),
                        timestampMs: msg.messageTimestamp * 1000
                    });
                } else {
                    // ===== MESSAGGIO RICEVUTO =====
                    console.log('📥 MESSAGGIO RICEVUTO:');
                    console.log(`├─ Mittente: ${contactInfo.displayName}`);
                    console.log(`├─ Numero: ${contactInfo.phoneNumber}`);
                    console.log(`├─ Tipo: ${messageType.toUpperCase()}`);
                    console.log(`├─ Contenuto: ${messageContent}`);
                    console.log(`├─ ID Messaggio: ${msg.key.id}`);
                    console.log(`└─ Timestamp: ${timeString}`);

                    // Log strutturato per messaggio ricevuto
                    log.whatsapp('Message received via WhatsApp', {
                        direction: 'incoming',
                        messageType,
                        from: msg.key.remoteJid,
                        fromFormatted: contactInfo.displayName,
                        content: messageContent,
                        messageId: msg.key.id,
                        timestamp: timestamp.toISOString(),
                        timestampMs: msg.messageTimestamp * 1000,
                        isGroup: msg.key.remoteJid.endsWith('@g.us'),
                        participant: msg.key.participant || null
                    });
                }
                console.log('─'.repeat(60));
            }
        } catch (error) {
            // Gestione specifica per errori di sessione/crittografia
            if (error.message && error.message.includes('Over 2000 messages into the future')) {
                console.error('🔐 Errore crittografico rilevato:', error.message);
                await this.handleSessionError(error);
            } else if (error.message && (
                error.message.includes('SessionError') ||
                error.message.includes('Failed to decrypt') ||
                error.message.includes('session_cipher')
            )) {
                console.error('🔑 Errore di sessione rilevato:', error.message);
                await this.handleSessionError(error);
            } else {
                // Altri errori generici
                console.error('❌ Errore nel gestore messaggi:', error.message);
                log.error('Message handler error', error);
            }
        }
        });

        // ===== EVENTI DI CONFERMA LETTURA =====
        this.sock.ev.on('message-receipt.update', (receipts) => {
            // Segnala attività WhatsApp per reset timeout
            if (this.connectionMonitor) {
                this.connectionMonitor.updateLastActivity();
            }

            for (const receipt of receipts) {
                const timestamp = new Date();
                const timeString = timestamp.toLocaleString('it-IT');
                const contactInfo = this.formatContactInfo(receipt.key.remoteJid);

                // Determina il tipo di conferma
                let receiptType = 'unknown';
                let icon = '📋';
                let description = 'Conferma sconosciuta';

                if (receipt.receipt.readTimestamp) {
                    receiptType = 'read';
                    icon = '👀';
                    description = 'MESSAGGIO LETTO';
                } else if (receipt.receipt.deliveredTimestamp) {
                    receiptType = 'delivered';
                    icon = '✅';
                    description = 'MESSAGGIO CONSEGNATO';
                } else if (receipt.receipt.sentTimestamp) {
                    receiptType = 'sent';
                    icon = '📤';
                    description = 'MESSAGGIO INVIATO';
                }

                console.log(`${icon} ${description}:`);
                console.log(`├─ Destinatario: ${contactInfo.displayName}`);
                console.log(`├─ Numero: ${contactInfo.phoneNumber}`);
                console.log(`├─ ID Messaggio: ${receipt.key.id}`);
                console.log(`└─ Timestamp: ${timeString}`);

                // Log strutturato per conferme
                log.whatsapp('Message receipt received', {
                    receiptType,
                    messageId: receipt.key.id,
                    contact: receipt.key.remoteJid,
                    contactFormatted: contactInfo.displayName,
                    timestamp: timestamp.toISOString(),
                    readTimestamp: receipt.receipt.readTimestamp ? new Date(receipt.receipt.readTimestamp * 1000).toISOString() : null,
                    deliveredTimestamp: receipt.receipt.deliveredTimestamp ? new Date(receipt.receipt.deliveredTimestamp * 1000).toISOString() : null,
                    sentTimestamp: receipt.receipt.sentTimestamp ? new Date(receipt.receipt.sentTimestamp * 1000).toISOString() : null
                });

                console.log('─'.repeat(60));
            }
        });

        // ===== EVENTI DI PRESENZA UTENTE =====
        this.sock.ev.on('presence.update', (presence) => {
            const contactInfo = this.formatContactInfo(presence.id);
            const timestamp = new Date();
            const timeString = timestamp.toLocaleString('it-IT');

            let statusIcon = '⚫';
            let statusText = 'sconosciuto';

            switch (presence.presences?.[presence.id]?.lastKnownPresence) {
                case 'available':
                    statusIcon = '🟢';
                    statusText = 'online';
                    break;
                case 'unavailable':
                    statusIcon = '⚫';
                    statusText = 'offline';
                    break;
                case 'composing':
                    statusIcon = '✏️';
                    statusText = 'sta scrivendo';
                    break;
                case 'recording':
                    statusIcon = '🎤';
                    statusText = 'sta registrando';
                    break;
                case 'paused':
                    statusIcon = '⏸️';
                    statusText = 'ha interrotto';
                    break;
            }

            // Mostra solo stati significativi (non offline di routine)
            if (presence.presences?.[presence.id]?.lastKnownPresence &&
                presence.presences[presence.id].lastKnownPresence !== 'unavailable') {

                console.log(`${statusIcon} STATO PRESENZA:`);
                console.log(`├─ Contatto: ${contactInfo.displayName}`);
                console.log(`├─ Numero: ${contactInfo.phoneNumber}`);
                console.log(`├─ Stato: ${statusText}`);
                console.log(`└─ Timestamp: ${timeString}`);

                // Log strutturato per presenza
                log.whatsapp('Presence update received', {
                    contact: presence.id,
                    contactFormatted: contactInfo.displayName,
                    presence: presence.presences[presence.id].lastKnownPresence,
                    timestamp: timestamp.toISOString()
                });

                console.log('─'.repeat(60));
            }
        });
        } catch (error) {
            console.error('Errore durante la connessione WhatsApp:', error);
            throw error;
        }
    }

    async reconnectForPairing() {
        const { PairingError } = require('../services/pairing-service');
        if (this.pairingReconnectPromise) return this.pairingReconnectPromise;
        const timedOutPairing = this.pairing.state === 'timeout' && this.sock;
        if ((this.sock || this.isConnecting) && !timedOutPairing) return this.pairing.status();
        if (Date.now() < (this.pairingReconnectAt || 0)) throw new PairingError('pairing_rate_limited', 429);
        this.pairingReconnectAt = Date.now() + 60000;
        this.reconnectAttempts = 0;
        if (timedOutPairing) {
            const oldSocket = this.sock; this.sock = null; this.isConnecting = false;
            this.connectionStatus = 'disconnected'; this.qrCode = null; this.qrCodeImage = null;
            this.pairing.update({ connection: 'close' });
            try { oldSocket.end(); } catch (_) {}
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.pairingReconnectPromise = (async () => {
            let writeTimer;
            try {
                await Promise.race([this.credentialWrites, new Promise((_, reject) => {
                    writeTimer = setTimeout(() => reject(new Error('timeout')), 30000);
                })]);
            } catch (_) {
                this.recoveryBlock = 'credentials_write_failed';
                this.lastConnectionError = 'credentials_write_failed';
                this.reconnectAt = null;
                throw new PairingError('credentials_write_failed', 503);
            }
            finally { clearTimeout(writeTimer); }
            await this.connect();
            return this.pairing.status();
        })().finally(() => { this.pairingReconnectPromise = null; });
        return this.pairingReconnectPromise;
    }

    async sendMessage(to, message = '', imageUrl = null, options = {}) {
        if (typeof to === 'string' && to.includes('@newsletter')) {
            throw new Error('Newsletter IDs require the dedicated channel service.');
        }
        if (this.connectionStatus !== 'connected' || !this.sock) {
            throw new Error('WhatsApp client is not connected.');
        }

        const startTime = new Date();

        try {
            // Determina il tipo di destinatario e prepara JID
            let jid = to;
            let messageType = 'individual';
            let targetInfo = {};

            if (GroupService.isGroupId(to)) {
                // È un gruppo - verifica esistenza e permessi
                const groupInfo = await GroupService.getGroupInfo(this.sock, to);

                // Verifica se si può inviare al gruppo
                if (groupInfo.isAnnounce && !groupInfo.isAdmin) {
                    throw new Error(`Il gruppo "${groupInfo.subject}" è solo-annunci e non hai permessi admin`);
                }

                jid = to;
                messageType = 'group';
                targetInfo = {
                    type: 'group',
                    name: groupInfo.subject,
                    id: groupInfo.id,
                    participantsCount: groupInfo.participantsCount,
                    isAnnounce: groupInfo.isAnnounce,
                    isAdmin: groupInfo.isAdmin
                };

                console.log(`📱 Invio a gruppo: ${groupInfo.subject} (${groupInfo.participantsCount} membri)`);
            } else {
                // È un numero individuale - normalizza
                let cleanNumber = to.replace(/[^\d]/g, '');

                log.debug(`🔍 Numero originale: ${to}`);
                log.debug(`🔍 Numero pulito: ${cleanNumber}`);

                // Normalizzazione numero italiano
                if (cleanNumber.startsWith('0039')) {
                    cleanNumber = '39' + cleanNumber.substring(4);
                    log.debug(`🔄 Rimosso 00 dal prefisso: ${cleanNumber}`);
                } else if (cleanNumber.startsWith('39')) {
                    log.debug(`✅ Prefisso 39 già presente: ${cleanNumber}`);
                } else if (cleanNumber.length === 10 && cleanNumber.startsWith('3')) {
                    cleanNumber = '39' + cleanNumber;
                    log.debug(`➕ Aggiunto prefisso 39: ${cleanNumber}`);
                } else {
                    log.debug(`🌍 Numero internazionale: ${cleanNumber}`);
                }

                if (cleanNumber.length < 10) {
                    throw new Error('Numero telefono non valido (troppo corto)');
                }

                jid = cleanNumber + '@s.whatsapp.net';
                messageType = 'individual';
                targetInfo = {
                    type: 'individual',
                    number: cleanNumber,
                    originalInput: to
                };

                // Verifica esistenza numero solo per numeri individuali
                const numberExists = await this.sock.onWhatsApp(jid);
                if (!numberExists || numberExists.length === 0) {
                    throw new Error(`Il numero ${cleanNumber} non è registrato su WhatsApp`);
                }

                console.log(`📱 Invio a numero: ${cleanNumber}`);
            }

            // Validazione contenuto messaggio
            const { attachmentUrl, attachmentFileName, attachmentMimeType } = options;
            let { attachmentBuffer, imageBuffer } = options;
            const { downloadMedia } = require('../services/media-download');
            if (imageUrl && !imageBuffer) imageBuffer = (await downloadMedia(imageUrl)).buffer;
            if (attachmentUrl && !attachmentBuffer) attachmentBuffer = (await downloadMedia(attachmentUrl, { image: false })).buffer;
            const hasAttachment = Boolean(attachmentUrl || attachmentBuffer);
            if ((imageUrl || imageBuffer) && hasAttachment) {
                throw new Error('Specificare solo uno tra immagine e allegato');
            }
            if (attachmentUrl && options.attachmentBuffer) {
                throw new Error('Specificare un allegato tramite URL o binario, non entrambi');
            }

            if (!message && !imageUrl && !imageBuffer && !hasAttachment) {
                throw new Error('Né messaggio di testo, immagine o allegato specificati');
            }

            // Prepara il contenuto del messaggio
            let messageContent;
            let contentType = 'text';

            if (imageUrl || imageBuffer) {
                // Messaggio con immagine
                messageContent = {
                    image: imageBuffer,
                    caption: message || undefined
                };
                contentType = 'image';
                console.log('📸 Preparazione immagine');
                if (message) {
                    console.log(`📝 Caption: ${message}`);
                }
            } else if (hasAttachment) {
                let fileName = attachmentFileName;
                if (!fileName) {
                    try {
                        fileName = attachmentUrl
                            ? decodeURIComponent(new URL(attachmentUrl).pathname.split('/').pop()) || 'allegato'
                            : 'allegato';
                    } catch {
                        fileName = 'allegato';
                    }
                }
                messageContent = {
                    document: attachmentBuffer,
                    mimetype: attachmentMimeType || 'application/octet-stream',
                    fileName,
                    caption: message || undefined
                };
                contentType = 'attachment';
                console.log('📎 Preparazione allegato');
            } else if (message) {
                // Solo testo
                messageContent = { text: message, linkPreview: null };
                contentType = 'text';
                console.log(`📝 Messaggio di testo: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
            }

            // Gestione messaggi effimeri
            if (options.ephemeral && options.expiration) {
                // Verifica che expiration sia un valore valido (in secondi)
                const validExpirations = [86400, 604800, 7776000]; // 24h, 7d, 90d
                if (!validExpirations.includes(options.expiration)) {
                    throw new Error('Invalid expiration time. Use 86400 (24h), 604800 (7d), or 7776000 (90d)');
                }

                messageContent.ephemeralExpiration = options.expiration;
                console.log(`⏱️ Impostazione messaggio effimero con scadenza: ${options.expiration} secondi`);
            }

            // Invia il messaggio
            console.log(`📤 Invio ${contentType} a ${messageType === 'group' ? 'gruppo' : 'numero'}: ${jid}`);
            const result = await this.sock.sendMessage(jid, messageContent);
            const duration = Date.now() - startTime;

            // Formatta informazioni contatto per logging
            const contactInfo = this.formatContactInfo(jid);

            // Log dettagliato successo
            const logDetails = {
                direction: 'outgoing',
                source: 'api_call',
                messageId: result.key.id,
                to: jid,
                toFormatted: targetInfo.name || contactInfo.displayName,
                messageType,
                contentType,
                hasImage: !!imageUrl,
                hasAttachment,
                hasText: !!message,
                content: message || (hasAttachment ? '[Allegato]' : '[Immagine]'),

                attachmentFileName: hasAttachment ? messageContent.fileName : null,
                attachmentMimeType: hasAttachment ? messageContent.mimetype : null,
                targetInfo,
                sendDurationMs: duration,
                timestamp: new Date().toISOString(),
                success: true
            };

            // Console output strutturato
            console.log(`📤 MESSAGGIO INVIATO VIA API:`);
            console.log(`├─ Tipo: ${messageType.toUpperCase()}`);
            console.log(`├─ Destinatario: ${targetInfo.name || contactInfo.displayName}`);
            console.log(`├─ ID: ${jid}`);
            console.log(`├─ Contenuto: ${contentType.toUpperCase()}`);
            if (message) {
                console.log(`├─ Testo: ${message.substring(0, 80)}${message.length > 80 ? '...' : ''}`);
            }
            if (imageUrl) {
                console.log('├─ Immagine presente');
            }
            if (hasAttachment) {
                console.log('├─ Allegato presente');
                console.log(`├─ Nome file: ${messageContent.fileName}`);
                console.log(`├─ MIME type: ${messageContent.mimetype}`);
            }
            console.log(`├─ ID Messaggio: ${result.key.id}`);
            console.log(`├─ Durata: ${duration}ms`);
            console.log(`└─ Timestamp: ${new Date().toLocaleString('it-IT')}`);

            // Log strutturato per file
            if (messageType === 'group') {
                log.whatsapp('Group message sent via API', logDetails);
            } else {
                log.whatsapp('Individual message sent via API', logDetails);
            }

            console.log('─'.repeat(60));

            return {
                ...result,
                messageType,
                contentType,
                targetInfo,
                duration,
                destinationType: messageType // Per compatibilità
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            const errorDetails = {
                direction: 'outgoing',
                source: 'api_call',
                to,
                error: 'delivery_failed',
                hasImage: !!imageUrl,
                hasAttachment: !!(options.attachmentUrl || options.attachmentBuffer),
                hasText: !!message,
                attemptDurationMs: duration,
                timestamp: new Date().toISOString(),
                success: false
            };

            // Console error output
            console.error(`❌ ERRORE INVIO MESSAGGIO:`);
            console.error(`├─ Destinatario: ${to}`);
            console.error('├─ Errore: delivery_failed');
            console.error(`├─ Durata tentativo: ${duration}ms`);
            console.error(`└─ Timestamp: ${new Date().toLocaleString('it-IT')}`);

            // Log strutturato errore
            log.error('Failed to send message via API');

            console.error('─'.repeat(60));
            throw error;
        }
    }

    // Nuovo metodo per ottenere gruppi
    async getGroups(forceRefresh = false) {
        if (!this.sock) {
            throw new Error('Client non connesso');
        }

        return await GroupService.getGroups(this.sock, forceRefresh);
    }

    // Nuovo metodo per info gruppo specifico
    async getGroupInfo(groupId) {
        if (!this.sock) {
            throw new Error('Client non connesso');
        }

        return await GroupService.getGroupInfo(this.sock, groupId);
    }

    // Nuovo metodo per cercare gruppi
    searchGroups(searchTerm) {
        return GroupService.searchGroups(searchTerm);
    }

    // Nuovo metodo per statistiche cache gruppi
    getGroupsCacheStats() {
        return GroupService.getCacheStats();
    }

    getQRCode() {
        return this.qrCode;
    }

    getQRCodeImage() {
        return this.qrCodeImage;
    }

    getStatus() {
        const authFilesExist = fs.existsSync(authStateDir);
        return {
            status: this.connectionStatus,
            diagnostic: { phase: this.connectionStatus === 'connected' ? 'authenticated' :
                this.pairing.state === 'requesting' ? 'pairing' : this.pairing.code ? 'pairing_code_available' :
                this.qrCodeImage ? 'qr_pending' : this.reconnectTimer ? 'reconnecting' :
                this.connectionStatus === 'connecting' ? 'connecting' :
                this.lastConnectionError ? 'error' : 'disconnected',
                socketPresent: !!this.sock, credentialsRetained: this.pairing.status().registered,
                credentialState: this.connectionStatus === 'connected' ? 'validated' :
                    this.pairing.status().registered ? 'retained_unvalidated' : 'unknown',
                lastDisconnectCode: this.pairing.status().lastDisconnectCode, lastError: this.lastConnectionError,
                recovery: { state: this.recoveryBlock ? 'blocked' : this.reconnectTimer ? 'scheduled' :
                    this.isConnecting ? 'connecting' : 'idle', reason: this.recoveryBlock || this.recoveryReason,
                    attempts: this.reconnectAttempts, nextAttemptAt: this.reconnectAt } },
            isConnecting: this.isConnecting,
            qrCode: this.qrCode ? 'available' : 'not_available',
            authFiles: authFilesExist ? 'present' : 'missing',
            connectionFailures: this.connectionFailures,
            lastFailureTime: this.lastFailureTime
        };
    }

    async cleanCorruptedAuthFiles() {
        try {
            if (fs.existsSync(authStateDir)) {
                console.log('🗑️ Rimozione file autenticazione corrotti...');
                fs.rmSync(authStateDir, { recursive: true, force: true });
                log.whatsapp('Corrupted authentication files cleaned successfully.');
                console.log('✅ File autenticazione rimossi. Nuovo QR code verrà generato.');

                // Reset dei contatori
                this.connectionFailures = 0;
                this.lastFailureTime = 0;

                return true;
            } else {
                console.log('ℹ️ Nessun file autenticazione da rimuovere.');
                return false;
            }
        } catch (error) {
            log.error('❌ Errore durante pulizia file autenticazione:', error.message);
            return false;
        }
    }

    async disconnect(forceLogout = false) {
        this.recoveryBlock = 'manual_disconnect';
        this.reconnectAt = null;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.socketWatchdog);
        this.connectionGeneration++;
        this.isConnecting = false;
        this.connectionStatus = 'disconnected';
        this.qrCode = null; this.qrCodeImage = null;
        this.reconnectTimer = null;
        if (this.sock) {
            const socket = this.sock;
            this.sock = null; // Retire before end/logout can emit a close event.
            this.pairing.update({ connection: 'close' });
            this.isConnecting = false;
            // Ferma il keep-alive prima di disconnettere
            this.stopKeepAlive();

            if (forceLogout) {
                console.log('🚪 Logout completo da WhatsApp...');
                await socket.logout();
            } else {
                console.log('🔌 Disconnessione soft (sessione mantenuta)...');
                // Solo chiude la connessione senza logout
                socket.end();
            }

            this.sock = null;
            this.connectionStatus = 'disconnected';
            log.whatsapp('Disconnected successfully.');
        }
    }

    async forceLogout() {
        console.log('🚪 Logout forzato da WhatsApp...');
        return this.disconnect(true);
    }

    // Carica la configurazione dal file config.ini
    loadConfig() {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config', 'config.ini');
            if (fs.existsSync(configPath)) {
                const configContent = fs.readFileSync(configPath, 'utf-8');
                const config = ini.parse(configContent);
                const safeConfig = JSON.parse(JSON.stringify(config));
                if (safeConfig.email?.smtp_password) {
                    safeConfig.email.smtp_password = '[REDACTED]';
                }
                console.log('🔍 📋 Configurazione caricata:', safeConfig);
                return config;
            } else {
                console.warn('⚠️ File config.ini non trovato, uso configurazione di default');
                return {
                    keepalive: {
                        enabled: 'false',
                        interval_minutes: '30',
                        group_id: '',
                        custom_message: ''
                    }
                };
            }
        } catch (error) {
            console.error('❌ Errore caricamento config.ini:', error.message);
            return { keepalive: { enabled: 'false' } };
        }
    }

    // Avvia il keep-alive se abilitato
    startKeepAlive() {
        // Gestisce sia booleani che stringhe per enabled
        const isEnabled = this.config.keepalive?.enabled === true ||
                         this.config.keepalive?.enabled === 'true';

        if (isEnabled && this.connectionStatus === 'connected') {
            const intervalMinutes = parseInt(this.config.keepalive.interval_minutes) || 30;
            const intervalMs = intervalMinutes * 60 * 1000; // Converti in millisecondi

            console.log(`🔄 Avvio keep-alive ogni ${intervalMinutes} minuti per gruppo ${this.config.keepalive.group_id}`);

            this.keepAliveInterval = setInterval(async () => {
                await this.sendKeepAliveMessage();
            }, intervalMs);

            // Invia il primo messaggio dopo 1 minuto
            setTimeout(() => {
                this.sendKeepAliveMessage();
            }, 60000);
        } else {
            console.log('🚫 Keep-alive disabilitato nella configurazione');
        }
    }

    // Ferma il keep-alive
    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            console.log('🛑 Keep-alive fermato');
        }
    }

    // Gestisce automaticamente gli errori di sessione WhatsApp
    async handleSessionError(error) {
        const now = Date.now();
        this.sessionErrorCount++;

        console.warn(`⚠️ Errore di sessione (#${this.sessionErrorCount}): ${error.message}`);
        console.warn('Session error detected', {
            errorCount: this.sessionErrorCount,
            errorMessage: error.message,
            timeSinceLastReset: now - this.lastSessionReset,
            maxSessionErrors: this.maxSessionErrors,
            autoRecoveryEnabled: this.autoRecoveryEnabled
        });

        // Controlla se l'auto-recovery è abilitato
        if (!this.autoRecoveryEnabled) {
            console.warn('⚠️ Auto-recovery disabilitato. Reset manuale necessario.');
            return;
        }

        // Se abbiamo troppi errori e è passato abbastanza tempo dall'ultimo reset
        if (this.sessionErrorCount >= this.maxSessionErrors &&
            (now - this.lastSessionReset) > this.sessionResetCooldown) {

            console.log(`🔄 Troppi errori di sessione (${this.sessionErrorCount}/${this.maxSessionErrors}), avvio reset automatico...`);
            await this.resetSessionDueToErrors();
        } else if (this.sessionErrorCount >= this.maxSessionErrors) {
            console.log(`⏳ Reset sessione in cooldown (${Math.round((this.sessionResetCooldown - (now - this.lastSessionReset)) / 1000)}s rimanenti)`);
        }
    }

    // Reset automatico della sessione a causa di errori
    async resetSessionDueToErrors() {
        try {
            const now = Date.now();
            this.lastSessionReset = now;
            this.sessionErrorCount = 0;

            console.log('🚨 RESET AUTOMATICO SESSIONE - Errori crittografici rilevati');
            console.warn('Automatic session reset triggered due to session errors');

            // Invia notifica se il keep-alive è abilitato
            if (this.config.keepalive?.enabled && this.config.keepalive?.group_id) {
                try {
                    const systemInfo = await this.getSystemInfo();
                    const resetMessage = `🚨 RESET AUTOMATICO SESSIONE
⏰ ${new Date().toLocaleString('it-IT')}
🖥️ Server: ${systemInfo.serverName}
🌐 IP Locale: ${systemInfo.ip}
🌍 IP Pubblico: ${systemInfo.publicIP}
📡 Provider: ${systemInfo.provider}
⚠️ Rilevati errori crittografici WhatsApp
🔄 Reset sessione in corso...
📱 Riconnessione automatica`;

                    await this.sock.sendMessage(this.config.keepalive.group_id, { text: resetMessage, linkPreview: null });
                    console.log('📢 Notifica reset inviata al gruppo');
                } catch (notifyError) {
                    console.warn('⚠️ Impossibile inviare notifica reset:', notifyError.message);
                }
            }

            // Disconnetti e pulisci la sessione
            await this.disconnect();

            // Recovery must preserve credentials. Destructive cleanup remains
            // an explicit administrative operation, never an automatic action.

            // Attendi un po' prima di riconnettersi
            console.log('⏳ Attesa 5 secondi prima della riconnessione...');
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Riconnetti con nuova autenticazione
            console.log('🔄 Riconnessione automatica in corso...');
            await this.connect();

        } catch (resetError) {
            console.error('❌ Errore durante reset automatico:', resetError.message);
            log.error('Failed to reset session automatically', resetError);
        }
    }

    // Ottiene informazioni IP pubblico e provider internet
    async getPublicIPInfo() {
        try {
            // Prova prima con ipinfo.io
            const ipInfo = await this.fetchIPInfo('https://ipinfo.io/json');
            if (ipInfo) {
                return {
                    publicIP: ipInfo.ip || 'N/A',
                    provider: ipInfo.org || 'N/A',
                    city: ipInfo.city || 'N/A',
                    country: ipInfo.country || 'N/A'
                };
            }
        } catch (error) {
            console.warn('⚠️ Errore recupero IP da ipinfo.io:', error.message);
        }

        try {
            // Fallback con ip-api.com
            const ipInfo = await this.fetchIPInfo('http://ip-api.com/json');
            if (ipInfo) {
                return {
                    publicIP: ipInfo.query || 'N/A',
                    provider: ipInfo.isp || 'N/A',
                    city: ipInfo.city || 'N/A',
                    country: ipInfo.country || 'N/A'
                };
            }
        } catch (error) {
            console.warn('⚠️ Errore recupero IP da ip-api.com:', error.message);
        }

        // Fallback finale con solo IP pubblico
        try {
            const ipInfo = await this.fetchIPInfo('https://api.ipify.org?format=json');
            if (ipInfo) {
                return {
                    publicIP: ipInfo.ip || 'N/A',
                    provider: 'N/A',
                    city: 'N/A',
                    country: 'N/A'
                };
            }
        } catch (error) {
            console.warn('⚠️ Errore recupero IP da ipify.org:', error.message);
        }

        // Se tutto fallisce
        return {
            publicIP: 'N/A',
            provider: 'N/A',
            city: 'N/A',
            country: 'N/A'
        };
    }

    // Helper per fare richieste HTTP
    fetchIPInfo(url) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https:') ? https : require('http');
            const request = protocol.get(url, { timeout: 5000 }, (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (error) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            request.on('timeout', () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });

            request.on('error', (error) => {
                reject(error);
            });
        });
    }

    // Ottiene informazioni del sistema per keep-alive
    async getSystemInfo() {
        try {
            // Legge la versione dal package.json
            const packagePath = path.join(__dirname, '../../package.json');
            const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

            // Ottiene IP locale
            const networkInterfaces = os.networkInterfaces();
            let localIP = 'localhost';

            // Cerca l'IP della rete locale (non loopback)
            for (const name of Object.keys(networkInterfaces)) {
                for (const net of networkInterfaces[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        localIP = net.address;
                        break;
                    }
                }
                if (localIP !== 'localhost') break;
            }

            // Ottiene informazioni IP pubblico e provider (con timeout)
            let publicIPInfo = {
                publicIP: 'N/A',
                provider: 'N/A',
                city: 'N/A',
                country: 'N/A'
            };

            try {
                publicIPInfo = await this.getPublicIPInfo();
            } catch (error) {
                console.warn('⚠️ Impossibile ottenere IP pubblico:', error.message);
            }

            return {
                serverName: os.hostname(),
                version: packageJson.version,
                ip: localIP,
                publicIP: publicIPInfo.publicIP,
                provider: publicIPInfo.provider,
                city: publicIPInfo.city,
                country: publicIPInfo.country,
                platform: `${os.type()} ${os.release()}`,
                uptime: process.uptime()
            };
        } catch (error) {
            console.warn('⚠️ Errore ottenimento info sistema:', error.message);
            return {
                serverName: os.hostname() || 'Unknown',
                version: '3.0.0',
                ip: 'localhost',
                publicIP: 'N/A',
                provider: 'N/A',
                city: 'N/A',
                country: 'N/A',
                platform: 'Unknown',
                uptime: process.uptime()
            };
        }
    }

    // Invia un messaggio di avvio del sistema
    async sendStartupMessage() {
        if (this.connectionStatus !== 'connected' || !this.sock) {
            console.warn('⚠️ Startup message: Client non connesso');
            return;
        }

        // Controlla se il keep-alive è abilitato
        const isEnabled = this.config.keepalive?.enabled === true ||
                         this.config.keepalive?.enabled === 'true';

        if (!isEnabled || !this.config.keepalive?.group_id) {
            console.log('🚫 Messaggio di avvio: keep-alive non configurato');
            return;
        }

        try {
            const groupId = this.config.keepalive.group_id;
            const systemInfo = await this.getSystemInfo();

            const message = `🚀 SISTEMA AVVIATO
⏰ ${new Date().toLocaleString('it-IT')}
🖥️ Server: ${systemInfo.serverName}
🌐 IP Locale: ${systemInfo.ip}
🌍 IP Pubblico: ${systemInfo.publicIP}
📡 Provider: ${systemInfo.provider}
🏙️ Località: ${systemInfo.city}, ${systemInfo.country}
📦 Versione: v${systemInfo.version}
💻 Sistema: ${systemInfo.platform}
✅ WhatsApp Proxy Server operativo`;

            console.log(`🚀 Invio messaggio di avvio al gruppo ${groupId}`);

            const result = await this.sock.sendMessage(groupId, { text: message, linkPreview: null });

            if (result && result.key) {
                console.log(`✅ Messaggio di avvio inviato con successo! ID: ${result.key.id}`);

                // Log strutturato per startup message
                log.whatsapp('Startup message sent successfully', {
                    direction: 'outgoing',
                    msgId: result.key.id,
                    to: groupId,
                    content: message,
                    messageType: 'startup',
                    timestamp: new Date().toISOString(),
                    source: 'automated'
                });
            }

        } catch (error) {
            console.error('❌ Errore invio messaggio di avvio:', error.message);
            log.error('Failed to send startup message', error);
        }
    }

    // Invia un messaggio keep-alive al gruppo
    async sendKeepAliveMessage() {
        if (this.connectionStatus !== 'connected' || !this.sock) {
            console.warn('⚠️ Keep-alive: Client non connesso');
            return;
        }

        try {
            const groupId = this.config.keepalive.group_id;
            const customMessage = this.config.keepalive.custom_message;
            const systemInfo = await this.getSystemInfo();

            // Calcola uptime leggibile
            const uptimeSeconds = Math.floor(systemInfo.uptime);
            const uptimeHours = Math.floor(uptimeSeconds / 3600);
            const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
            const uptimeText = `${uptimeHours}h ${uptimeMinutes}m`;

            const message = customMessage ||
                `🤖 Keep-alive automatico
⏰ ${new Date().toLocaleString('it-IT')}
🖥️ Server: ${systemInfo.serverName}
🌐 IP Locale: ${systemInfo.ip}
🌍 IP Pubblico: ${systemInfo.publicIP}
📡 Provider: ${systemInfo.provider}
🏙️ Località: ${systemInfo.city}, ${systemInfo.country}
📦 Versione: v${systemInfo.version}
💻 Sistema: ${systemInfo.platform}
⏱️ Uptime: ${uptimeText}
🔄 Server attivo e funzionante`;

            console.log(`💬 Invio keep-alive al gruppo ${groupId}`);

            const result = await this.sock.sendMessage(groupId, { text: message, linkPreview: null });

            if (result && result.key) {
                console.log(`✅ Keep-alive inviato con successo! ID: ${result.key.id}`);

                // Log strutturato per keep-alive
                log.whatsapp('Keep-alive message sent successfully', {
                    direction: 'outgoing',
                    msgId: result.key.id,
                    to: groupId,
                    content: message,
                    messageType: 'keep-alive',
                    timestamp: new Date().toISOString(),
                    source: 'automated'
                });
            }

        } catch (error) {
            console.error('❌ Errore invio keep-alive:', error.message);
            log.error('Failed to send keep-alive message', error);
        }
    }

    // Ricarica la configurazione dal file
    reloadConfig() {
        console.log('🔄 Ricaricamento configurazione...');
        this.config = this.loadConfig();

        // Riavvia il keep-alive se necessario
        this.stopKeepAlive();
        if (this.connectionStatus === 'connected') {
            this.startKeepAlive();
        }

        return this.config;
    }

    // Restituisce lo stato del keep-alive
    getKeepAliveStatus() {
        const isEnabled = this.config?.keepalive?.enabled === 'true' || this.config?.keepalive?.enabled === true;
        const intervalMinutes = parseInt(this.config?.keepalive?.interval_minutes || 30);
        const groupId = this.config?.keepalive?.group_id || '';

        return {
            enabled: isEnabled,
            running: this.keepAliveInterval !== null,
            intervalMinutes: intervalMinutes,
            groupId: groupId,
            customMessage: this.config?.keepalive?.custom_message || '',
            connectionStatus: this.connectionStatus,
            connectionFailures: this.connectionFailures
        };
    }

    /**
     * Cancella fisicamente i file di autenticazione corrotti
     * Necessario per risolvere errori SessionError persistenti
     */
    async cleanAuthFiles() {
        try {
            const authStateDir = path.join(__dirname, '../../data/auth');

            console.log(`🗑️ Pulizia directory auth: ${authStateDir}`);

            if (fs.existsSync(authStateDir)) {
                // Legge tutti i file nella directory di autenticazione
                const files = fs.readdirSync(authStateDir);

                console.log(`📁 Trovati ${files.length} file di autenticazione`);

                for (const file of files) {
                    const filePath = path.join(authStateDir, file);

                    try {
                        // Cancella solo file JSON (chiavi di sessione)
                        if (file.endsWith('.json') || file.startsWith('app-state-sync-key-')) {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Cancellato: ${file}`);
                        }
                    } catch (fileError) {
                        console.warn(`⚠️ Impossibile cancellare ${file}:`, fileError.message);
                    }
                }

                console.log('✅ Pulizia file di autenticazione completata');
            } else {
                console.log('📂 Directory auth non esistente, nessuna pulizia necessaria');
            }

        } catch (error) {
            console.error('❌ Errore durante pulizia file auth:', error.message);
            throw error;
        }
    }

    getConnectionMonitorStatus() {
        if (!this.connectionMonitor) {
            return {
                monitoring: false,
                error: 'Connection monitor not initialized'
            };
        }
        return this.connectionMonitor.getStats();
    }

    /**
     * Formatta le informazioni di un contatto per visualizzazione migliore
     * @param {string} jid - JID del contatto WhatsApp
     * @returns {object} Informazioni formattate del contatto
     */
    formatContactInfo(jid) {
        if (!jid) {
            return {
                displayName: 'Sconosciuto',
                phoneNumber: 'N/A',
                isGroup: false,
                isServer: false
            };
        }

        const isGroup = jid.endsWith('@g.us');
        const isServer = jid.endsWith('@s.whatsapp.net');

        if (isGroup) {
            // Per i gruppi, estrae l'ID del gruppo
            const groupId = jid.split('@')[0];
            return {
                displayName: `Gruppo ID: ${groupId}`,
                phoneNumber: jid,
                isGroup: true,
                isServer: false
            };
        } else if (isServer) {
            // Per i contatti normali, estrae il numero di telefono
            const phoneNumber = jid.split('@')[0];
            let formattedNumber = phoneNumber;

            // Formatta i numeri italiani per una migliore leggibilità
            if (phoneNumber.startsWith('39') && phoneNumber.length === 12) {
                // Numero italiano: +39 XXX XXX XXXX
                const italianNumber = phoneNumber.substring(2); // Rimuove 39
                formattedNumber = `+39 ${italianNumber.substring(0, 3)} ${italianNumber.substring(3, 6)} ${italianNumber.substring(6)}`;
            } else if (phoneNumber.length >= 10) {
                // Altri numeri internazionali: aggiunge spazi per leggibilità
                const countryCode = phoneNumber.substring(0, 2);
                const restNumber = phoneNumber.substring(2);
                formattedNumber = `+${countryCode} ${restNumber}`;
            }

            return {
                displayName: formattedNumber,
                phoneNumber: phoneNumber,
                isGroup: false,
                isServer: true
            };
        }

        // Fallback per JID non riconosciuti
        return {
            displayName: jid,
            phoneNumber: jid,
            isGroup: false,
            isServer: false
        };
    }

    /**
     * Invia un messaggio effimero (temporaneo)
     * @param {string} to - Destinatario (numero o ID gruppo)
     * @param {string} message - Testo del messaggio
     * @param {string} imageUrl - URL immagine (opzionale)
     * @param {number} expiration - Tempo di scadenza in secondi (86400, 604800, 7776000)
     * @returns {Object} Risultato dell'invio
     */
    async sendEphemeralMessage(to, message = '', imageUrl = null, expiration = 86400) {
        return await this.sendMessage(to, message, imageUrl, {
            ephemeral: true,
            expiration: expiration
        });
    }

    /**
     * Configura le impostazioni dei messaggi effimeri per un gruppo
     * @param {string} groupId - ID del gruppo
     * @param {number} expiration - Tempo di scadenza in secondi (0 per disabilitare, 86400, 604800, 7776000)
     * @returns {Object} Risultato dell'operazione
     */
    async setGroupEphemeralSetting(groupId, expiration) {
        if (this.connectionStatus !== 'connected' || !this.sock) {
            throw new Error('WhatsApp client is not connected.');
        }

        const validExpirations = [0, 86400, 604800, 7776000]; // 0=disabled, 24h, 7d, 90d
        if (!validExpirations.includes(expiration)) {
            throw new Error('Invalid expiration time. Use 0 (disabled), 86400 (24h), 604800 (7d), or 7776000 (90d)');
        }

        try {
            // Normalizza l'ID del gruppo
            const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;

            // Configura i messaggi effimeri per il gruppo
            await this.sock.groupToggleEphemeral(jid, expiration);

            const durationText = expiration === 0 ? 'disabilitati' :
                               expiration === 86400 ? '24 ore' :
                               expiration === 604800 ? '7 giorni' : '90 giorni';

            console.log(`⏱️ Messaggi effimeri ${durationText} per gruppo: ${jid}`);

            return {
                success: true,
                groupId: jid,
                ephemeralExpiration: expiration,
                durationText: durationText,
                message: `Messaggi effimeri impostati a: ${durationText}`
            };
        } catch (error) {
            console.error('❌ Errore configurazione messaggi effimeri gruppo:', error);
            throw new Error(`Failed to set group ephemeral settings: ${error.message}`);
        }
    }
}

module.exports = new BaileysClient();
