/**
 * Sistema di Notifiche Email
 *
 * Gestisce l'invio di email per notifiche di errore e stato connessione WhatsApp
 */

const nodemailer = require('nodemailer');
const { log } = require('./logger');

class EmailNotifier {
    constructor(config) {
        this.config = config?.email || {};
        this.enabled = this.config.enabled === 'true' || this.config.enabled === true;
        this.transporter = null;
        this.lastEmailSent = null;
        this.cooldownMinutes = parseInt(
            this.config.disconnection_alert_interval_minutes || this.config.email_cooldown_minutes
        ) || 60;

        if (this.enabled) {
            this.setupTransporter();
        } else {
            log.debug('Email notifications disabled');
        }
    }

    setupTransporter() {
        try {
            this.transporter = nodemailer.createTransport({
                host: this.config.smtp_host,
                port: parseInt(this.config.smtp_port),
                secure: this.config.smtp_secure === 'true',
                auth: {
                    user: this.config.smtp_user,
                    pass: this.config.smtp_password
                }
            });

            // Test della connessione
            this.transporter.verify((error, success) => {
                if (error) {
                    log.error('Errore configurazione email', error, {
                        smtp_host: this.config.smtp_host,
                        smtp_port: this.config.smtp_port
                    });
                } else {
                    log.startup('✉️ Sistema email configurato correttamente');
                }
            });

        } catch (error) {
            log.error('Errore inizializzazione email transporter', error);
            this.enabled = false;
        }
    }

    async sendConnectionAlert(connectionStatus, errorDetails = null) {
        if (!this.enabled || !this.canSendEmail()) {
            return false;
        }

        const subject = '🚨 WhatsApp Proxy - Problema di Connessione';
        const timestamp = new Date().toLocaleString('it-IT');

        let htmlContent = `
            <h2 style="color: #e74c3c;">🚨 Allarme WhatsApp Proxy</h2>
            <p><strong>Timestamp:</strong> ${timestamp}</p>
            <p><strong>Stato Connessione:</strong> ${connectionStatus}</p>
        `;

        if (errorDetails) {
            htmlContent += `
                <h3>Dettagli Errore:</h3>
                <p><strong>Messaggio:</strong> ${errorDetails.message || 'N/A'}</p>
                <p><strong>Codice:</strong> ${errorDetails.code || 'N/A'}</p>
                <p><strong>Stack:</strong></p>
                <pre style="background: #f8f8f8; padding: 10px; border-radius: 4px;">${errorDetails.stack || 'N/A'}</pre>
            `;
        }

        htmlContent += `
            <h3>Azioni Consigliate:</h3>
            <ul>
                <li>Verificare la connessione internet</li>
                <li>Controllare i log del server</li>
                <li>Riavviare il servizio se necessario</li>
                <li>Verificare lo stato dei server WhatsApp</li>
            </ul>

            <p style="color: #7f8c8d; font-size: 0.9em;">
                Questo è un messaggio automatico dal sistema WhatsApp Proxy.<br>
                Server: ${require('os').hostname()}<br>
                Processo: ${process.pid}
            </p>
        `;

        const textContent = `
WhatsApp Proxy - Allarme Connessione

Timestamp: ${timestamp}
Stato: ${connectionStatus}

${errorDetails ? `
Errore: ${errorDetails.message}
Codice: ${errorDetails.code}
` : ''}

Azioni consigliate:
- Verificare connessione internet
- Controllare i log del server
- Riavviare il servizio se necessario
- Verificare stato server WhatsApp

Server: ${require('os').hostname()}
Processo: ${process.pid}
        `;

        const mailOptions = {
            from: this.config.from_email,
            to: this.config.to_email,
            subject: subject,
            text: textContent,
            html: htmlContent
        };

        try {
            const info = await this.transporter.sendMail(mailOptions);
            this.lastEmailSent = Date.now();

            log.server('✉️ Email di notifica inviata', {
                to: this.config.to_email,
                messageId: info.messageId,
                status: connectionStatus
            });

            return true;
        } catch (error) {
            log.error('Errore invio email di notifica', error, {
                to: this.config.to_email,
                smtp_host: this.config.smtp_host
            });
            return false;
        }
    }

    async sendRecoveryNotification() {
        if (!this.enabled) {
            return false;
        }

        const subject = '✅ WhatsApp Proxy - Connessione Ripristinata';
        const timestamp = new Date().toLocaleString('it-IT');

        const htmlContent = `
            <h2 style="color: #27ae60;">✅ WhatsApp Proxy - Connessione Ripristinata</h2>
            <p><strong>Timestamp:</strong> ${timestamp}</p>
            <p>La connessione a WhatsApp è stata ripristinata con successo.</p>
            <p>Il sistema è tornato operativo e può processare messaggi normalmente.</p>

            <p style="color: #7f8c8d; font-size: 0.9em;">
                Messaggio automatico dal sistema WhatsApp Proxy.<br>
                Server: ${require('os').hostname()}<br>
                Processo: ${process.pid}
            </p>
        `;

        const textContent = `
WhatsApp Proxy - Connessione Ripristinata

Timestamp: ${timestamp}
La connessione a WhatsApp è stata ripristinata con successo.
Il sistema è tornato operativo.

Server: ${require('os').hostname()}
Processo: ${process.pid}
        `;

        const mailOptions = {
            from: this.config.from_email,
            to: this.config.to_email,
            subject: subject,
            text: textContent,
            html: htmlContent
        };

        try {
            const info = await this.transporter.sendMail(mailOptions);
            this.lastEmailSent = Date.now();

            log.server('✉️ Email di ripristino inviata', {
                to: this.config.to_email,
                messageId: info.messageId
            });

            return true;
        } catch (error) {
            log.error('Errore invio email di ripristino', error);
            return false;
        }
    }

    canSendEmail() {
        if (!this.lastEmailSent) {
            return true;
        }

        const timeSinceLastEmail = Date.now() - this.lastEmailSent;
        const cooldownMs = this.cooldownMinutes * 60 * 1000;

        return timeSinceLastEmail >= cooldownMs;
    }

    getCooldownStatus() {
        if (!this.lastEmailSent) {
            return { inCooldown: false, remainingMinutes: 0 };
        }

        const timeSinceLastEmail = Date.now() - this.lastEmailSent;
        const cooldownMs = this.cooldownMinutes * 60 * 1000;
        const remainingMs = cooldownMs - timeSinceLastEmail;

        if (remainingMs <= 0) {
            return { inCooldown: false, remainingMinutes: 0 };
        }

        return {
            inCooldown: true,
            remainingMinutes: Math.ceil(remainingMs / (60 * 1000))
        };
    }
}

module.exports = EmailNotifier;
