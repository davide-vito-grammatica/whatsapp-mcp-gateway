/**
 * Sistema di Logging Centralizzato
 *
 * Utilizza Pino per gestire i log sia su console che su file
 * con rotazione automatica e diversi livelli di log.
 */

const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Crea la cartella logs se non esiste (con gestione errori robusta)
const logsDir = path.join(__dirname, '..', '..', 'data', 'logs');
let canWriteLogs = true;

try {
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    // Test di scrittura per verificare i permessi
    const testFile = path.join(logsDir, '.test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
} catch (error) {
    console.warn('⚠️ Impossibile creare/accedere alla directory logs:', error.message);
    console.warn('⚠️ Logging su file disabilitato - verrà usata solo la console');
    canWriteLogs = false;
}

// Configurazione stream per file (solo se possibile)
let logFile, errorLogFile, logStream, errorStream, fileLogger;

if (canWriteLogs) {
    logFile = path.join(logsDir, 'whatsapp-proxy.log');
    errorLogFile = path.join(logsDir, 'error.log');

    // Stream per log generali
    logStream = pino.destination({
        dest: logFile,
        sync: false,
        mkdir: true
    });

    // Stream per errori
    errorStream = pino.destination({
        dest: errorLogFile,
        sync: false,
        mkdir: true
    });

    // Logger per file (formato JSON strutturato)
    fileLogger = pino({
        level: process.env.LOG_LEVEL || 'info',
        formatters: {
            level: (label) => {
                return { level: label };
            }
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        base: {
            pid: process.pid,
            hostname: require('os').hostname()
        }
    }, pino.multistream([
        { stream: logStream, level: 'debug' },
        { stream: errorStream, level: 'error' }
    ]));

    console.log('✅ Logging su file abilitato:', logsDir);
} else {
    // Logger fittizio se non possiamo scrivere su file
    fileLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {}
    };
}

// Logger per console (formato umano)
const consoleLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
    debug: (message) => console.debug(message)
};

// Logger specifico per Baileys (silenzioso per evitare spam)
const baileysLogger = pino({
    level: 'silent'
});

// Funzioni helper per logging formattato
const formatters = {
    server: (message, data = {}) => {
        // Console formato umano con dettagli
        consoleLogger.info(`🚀 ${message}`);

        // Se ci sono dati da mostrare, mostrarli in modo leggibile
        if (Object.keys(data).length > 0) {
            // Mostra tutti gli endpoint/dati in modo strutturato
            Object.entries(data).forEach(([key, value]) => {
                if (typeof value === 'string') {
                    consoleLogger.info(`   ${key}: ${value}`);
                } else if (typeof value === 'object' && value !== null) {
                    // Se è un oggetto, mostra i suoi contenuti
                    Object.entries(value).forEach(([subKey, subValue]) => {
                        consoleLogger.info(`   ${subKey}: ${subValue}`);
                    });
                } else {
                    consoleLogger.info(`   ${key}: ${value}`);
                }
            });
        }

        // File formato JSON
        fileLogger.info({ component: 'server', ...data }, `🚀 ${message}`);
    },

    whatsapp: (message, data = {}) => {
        // Console formato umano
        consoleLogger.info(`📱 ${message}`);
        // File formato JSON
        fileLogger.info({ component: 'whatsapp', ...data }, `📱 ${message}`);
    },

    api: (method, path, status, duration = null) => {
        const emoji = status >= 400 ? '❌' : '✅';
        const durationText = duration ? ` (${duration}ms)` : '';

        // Console formato umano
        consoleLogger.info(`${emoji} ${method} ${path} - ${status}${durationText}`);

        // File formato JSON
        const logData = { method, path, status, component: 'api' };
        if (duration) logData.duration = `${duration}ms`;
        fileLogger.info(logData, `${emoji} ${method} ${path} - ${status}`);
    },

    keepalive: (message, data = {}) => {
        // Console formato umano
        consoleLogger.info(`🤖 ${message}`);
        // File formato JSON
        fileLogger.info({ component: 'keepalive', ...data }, `🤖 ${message}`);
    },

    auth: (message, data = {}) => {
        // Console formato umano
        consoleLogger.info(`🔐 ${message}`);
        // File formato JSON
        fileLogger.info({ component: 'auth', ...data }, `🔐 ${message}`);
    },

    error: (message, error = null, data = {}) => {
        // Console formato umano
        const errorText = error ? ` - ${error.message}` : '';
        consoleLogger.error(`❌ ${message}${errorText}`);

        // File formato JSON
        const logData = { component: 'error', ...data };
        if (error) {
            logData.error = error.message;
            logData.stack = error.stack;
        }
        fileLogger.error(logData, `❌ ${message}`);
    },

    debug: (message, data = {}) => {
        // Console formato umano
        consoleLogger.debug(`🔍 ${message}`);
        // File formato JSON
        fileLogger.debug({ component: 'debug', ...data }, `🔍 ${message}`);
    },

    startup: (message, data = {}) => {
        // Console formato umano
        consoleLogger.info(`🌟 ${message}`);
        // File formato JSON
        fileLogger.info({ component: 'startup', ...data }, `🌟 ${message}`);
    }
};

// Middleware per Express logging
const expressMiddleware = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        formatters.api(req.method, req.path, res.statusCode, duration);
    });

    next();
};

// Gestione degli errori non catturati
process.on('uncaughtException', (error) => {
    formatters.error('Uncaught Exception', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    formatters.error('Unhandled Rejection', reason);
});

module.exports = {
    // Logger principali
    logger: fileLogger,  // Logger per file JSON
    consoleLogger,       // Logger per console umana
    baileysLogger,

    // Formatter per diversi componenti
    log: formatters,

    // Middleware Express
    expressMiddleware,

    // Info sui file di log (solo se disponibili)
    logFiles: canWriteLogs ? {
        main: logFile,
        error: errorLogFile,
        enabled: true
    } : {
        enabled: false,
        message: 'Logging su file disabilitato per problemi di permessi'
    },

    // Flag per sapere se il logging su file è disponibile
    canWriteLogs
};
