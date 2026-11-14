/**
 * WhatsApp Proxy Server - Main Entry Point
 *
 * Punto di ingresso principale del server.
 * Il codice del server è organizzato in src/server/app.js
 */

const { log } = require('./src/utils/logger');

log.startup('Starting WhatsApp Proxy Server...');
log.startup(`Loading from: ${__dirname}`);

// Verifica che il file esista
const fs = require('fs');
const appPath = './src/server/app.js';

if (!fs.existsSync(appPath)) {
    log.error(`File app.js non trovato in: ${appPath}`);
    process.exit(1);
}

try {
    log.startup('Loading server module...');
    log.debug(`Path: ${require.resolve(appPath)}`);
    // Importa e avvia il server principale
    require('./src/server/app.js');
    log.startup('Server module loaded successfully!');
} catch (error) {
    log.error('Error loading server', error);
    process.exit(1);
}
