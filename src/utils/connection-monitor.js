/**
 * Monitor Connessione WhatsApp
 *
 * Monitora lo stato della connessione e invia notifiche email in caso di problemi
 */

const { log } = require('./logger');

class ConnectionMonitor {
    constructor(emailNotifier, config) {
        this.emailNotifier = emailNotifier;
        this.config = config || {};
        this.connectionTimeoutMinutes = parseInt(this.config.email?.connection_timeout_minutes) || 15;
        this.alertIntervalMinutes = parseInt(
            this.config.email?.disconnection_alert_interval_minutes ||
            this.config.email?.email_cooldown_minutes
        ) || 60;

        // Stati del monitor
        this.lastConnectionTime = Date.now();
        this.connectionStatus = 'connecting';
        this.isConnected = false;
        this.alertSent = false;
        this.lastAlertAt = null;
        this.isSendingAlert = false;
        this.recoverySent = false;

        // Timer per il monitoraggio
        this.monitorInterval = null;

        // Non avviare automaticamente il monitoraggio
        log.debug('Monitor connessione inizializzato', {
            timeout_minutes: this.connectionTimeoutMinutes
        });
    }

    start() {
        this.startMonitoring();
    }

    startMonitoring() {
        if (this.monitorInterval) {
            return;
        }

        // Controlla ogni minuto lo stato della connessione
        this.monitorInterval = setInterval(() => {
            this.checkConnectionStatus();
        }, 60 * 1000); // 1 minuto

        log.startup('🔍 Monitor connessione WhatsApp avviato', {
            timeout_minutes: this.connectionTimeoutMinutes,
            alert_interval_minutes: this.alertIntervalMinutes,
            check_interval: '1 minuto'
        });
    }

    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            log.debug('Monitor connessione fermato');
        }
    }

    updateConnectionStatus(status, error = null) {
        const previousStatus = this.connectionStatus;
        this.connectionStatus = status;

        switch (status) {
            case 'open':
            case 'connected':
                this.onConnectionSuccess();
                break;

            case 'close':
            case 'connecting':
                this.onConnectionLost(error);
                break;

            default:
                log.debug('Stato connessione sconosciuto', { status });
        }

        // Log cambio stato se significativo
        if (previousStatus !== status) {
            log.whatsapp(`Cambio stato connessione: ${previousStatus} → ${status}`, {
                previous: previousStatus,
                current: status,
                connected: this.isConnected
            });
        }
    }

    onConnectionSuccess() {
        const wasDisconnected = !this.isConnected;

        this.isConnected = true;
        this.lastConnectionTime = Date.now();
        this.alertSent = false;
        this.lastAlertAt = null;

        // Se era disconnesso e ora è connesso, invia email di ripristino
        if (wasDisconnected && this.recoverySent) {
            this.sendRecoveryEmail();
            this.recoverySent = false;
        }
    }

    onConnectionLost(error = null) {
        if (this.isConnected) {
            this.lastConnectionTime = Date.now();
        }
        this.isConnected = false;

        // Log dell'errore se presente
        if (error) {
            log.error('Connessione WhatsApp persa', error, {
                lastConnection: new Date(this.lastConnectionTime).toISOString(),
                status: this.connectionStatus
            });
        }
    }

    /**
     * Segnala attività WhatsApp recente (messaggi ricevuti/inviati)
     * Questo può essere usato per resettare il timer di timeout anche se
     * lo stato ufficiale della connessione non è "open"
     */
    updateLastActivity() {
        this.lastConnectionTime = Date.now();

        // Se eravamo in stato di allarme e ora riceviamo attività, reset alert
        if (this.alertSent && this.getDisconnectedMinutes() < 1) {
            this.alertSent = false;
            log.whatsapp('🟢 Attività WhatsApp rilevata - Reset allarme timeout', {
                last_activity: new Date(this.lastConnectionTime).toISOString()
            });
        }
    }

    checkConnectionStatus() {
        if (this.isConnected) {
            // Se connesso, reset timer
            this.lastConnectionTime = Date.now();
            return;
        }

        const disconnectedMinutes = this.getDisconnectedMinutes();

        log.debug('Controllo stato connessione', {
            disconnected_minutes: disconnectedMinutes,
            timeout_threshold: this.connectionTimeoutMinutes,
            alert_sent: this.alertSent
        });

        const alertDue = !this.lastAlertAt ||
            Date.now() - this.lastAlertAt >= this.alertIntervalMinutes * 60 * 1000;

        // Dopo il timeout, reinvia l'allarme ogni intervallo configurato finché resta disconnesso.
        if (disconnectedMinutes >= this.connectionTimeoutMinutes && alertDue && !this.isSendingAlert) {
            this.sendConnectionAlert(disconnectedMinutes);
        }
    }

    getDisconnectedMinutes() {
        const now = Date.now();
        const disconnectedMs = now - this.lastConnectionTime;
        return Math.floor(disconnectedMs / (60 * 1000));
    }

    async sendConnectionAlert(disconnectedMinutes) {
        this.isSendingAlert = true;
        const errorDetails = {
            message: `Connessione WhatsApp persa da ${disconnectedMinutes} minuti`,
            code: 'CONNECTION_TIMEOUT',
            disconnected_since: new Date(this.lastConnectionTime).toISOString(),
            current_status: this.connectionStatus
        };

        log.error('🚨 Timeout connessione WhatsApp - Invio email', null, {
            disconnected_minutes: disconnectedMinutes,
            timeout_threshold: this.connectionTimeoutMinutes,
            last_connection: new Date(this.lastConnectionTime).toISOString()
        });

        try {
            const emailSent = await this.emailNotifier.sendConnectionAlert(
                `Disconnesso da ${disconnectedMinutes} minuti`,
                errorDetails
            );

            if (emailSent) {
                this.alertSent = true;
                this.lastAlertAt = Date.now();
                this.recoverySent = true; // Segna che dobbiamo inviare email di ripristino
                log.server('✉️ Email di allarme connessione inviata con successo');
            } else {
                log.error('Impossibile inviare email di allarme connessione');
            }
        } catch (error) {
            log.error('Errore durante invio email di allarme', error);
        } finally {
            this.isSendingAlert = false;
        }
    }

    async sendRecoveryEmail() {
        try {
            const emailSent = await this.emailNotifier.sendRecoveryNotification();

            if (emailSent) {
                log.server('✉️ Email di ripristino connessione inviata con successo');
            } else {
                log.error('Impossibile inviare email di ripristino');
            }
        } catch (error) {
            log.error('Errore durante invio email di ripristino', error);
        }
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            connectionStatus: this.connectionStatus,
            lastConnectionTime: new Date(this.lastConnectionTime).toISOString(),
            disconnectedMinutes: this.getDisconnectedMinutes(),
            timeoutThreshold: this.connectionTimeoutMinutes,
            alertIntervalMinutes: this.alertIntervalMinutes,
            alertSent: this.alertSent,
            lastAlertAt: this.lastAlertAt ? new Date(this.lastAlertAt).toISOString() : null,
            emailCooldown: this.emailNotifier.getCooldownStatus()
        };
    }
}

module.exports = ConnectionMonitor;
