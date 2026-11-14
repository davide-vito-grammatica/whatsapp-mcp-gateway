/**
 * Config Loader - Modulo condiviso per caricare config.ini
 */

const fs = require('fs');
const path = require('path');
const ini = require('ini');

class ConfigLoader {
    constructor() {
        this.config = null;
        this.configPath = path.join(__dirname, '..', '..', 'config', 'config.ini');
    }

    /**
     * Carica la configurazione dal file config.ini
     * @returns {Object} Configurazione caricata
     */
    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const configContent = fs.readFileSync(this.configPath, 'utf-8');
                this.config = ini.parse(configContent);
                console.log('🔍 📋 Configurazione caricata da config.ini');
                return this.config;
            } else {
                console.warn('⚠️ File config.ini non trovato, uso configurazione di default');
                this.config = this.getDefaultConfig();
                return this.config;
            }
        } catch (error) {
            console.error('❌ Errore caricamento config.ini:', error.message);
            this.config = this.getDefaultConfig();
            return this.config;
        }
    }

    /**
     * Ottiene la configurazione di default
     * @returns {Object} Configurazione di default
     */
    getDefaultConfig() {
        return {
            server: {
                port: '3000'
            },
            keepalive: {
                enabled: 'false',
                interval_minutes: '30',
                group_id: '',
                custom_message: ''
            },
            email: {
                enabled: 'false',
                smtp_host: 'smtp.gmail.com',
                smtp_port: '587',
                smtp_secure: 'false',
                smtp_user: '',
                smtp_password: '',
                from_email: '',
                to_email: '',
                connection_timeout_minutes: '20',
                retry_count: '3',
                notification_cooldown_minutes: '30'
            }
        };
    }

    /**
     * Ottiene la porta del server dalla configurazione
     * @returns {number} Porta del server
     */
    getServerPort() {
        if (!this.config) {
            this.loadConfig();
        }
        return parseInt(this.config?.server?.port || '3000', 10);
    }

    /**
     * Ottiene la configurazione completa
     * @returns {Object} Configurazione completa
     */
    getConfig() {
        if (!this.config) {
            this.loadConfig();
        }
        return this.config;
    }

    /**
     * Ricarica la configurazione dal file
     * @returns {Object} Configurazione aggiornata
     */
    reloadConfig() {
        return this.loadConfig();
    }
}

// Esporta un'istanza singleton
module.exports = new ConfigLoader();
