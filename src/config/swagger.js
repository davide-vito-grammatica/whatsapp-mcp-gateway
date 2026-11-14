const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    security: [{ bearerAuth: [] }],
    info: {
      title: 'WhatsApp Proxy API',
  version: '3.0.0',
      description: `
        # WhatsApp Web API Proxy

        Un server Node.js moderno che utilizza @whiskeysockets/baileys per creare un'API REST completa per inviare messaggi WhatsApp con funzionalità avanzate di keep-alive automatico e gestione intelligente delle sessioni.

        ## 🚀 Caratteristiche
        - ✅ **API REST completa** per invio messaggi WhatsApp
        - ✅ **Connessione diretta** senza Puppeteer (più stabile)
        - ✅ **Keep-alive automatico** per gruppi con configurazione INI
        - ✅ **Gestione QR Code** via API e console
        - ✅ **Auto-recovery** file autenticazione corrotti
        - ✅ **Sessioni persistenti** tra restart

        ## 🔐 Autenticazione

        Usa Authorize con il token API per lettura e invio, oppure con il token admin per QR, sessione e configurazione.
        Per la prima connessione:
        1. Apri \`GET /session/link\` e inserisci il token amministrativo per visualizzare il QR code
        2. Scansiona il QR code con WhatsApp
        3. La sessione sarà salvata automaticamente per i prossimi utilizzi

        ## 📞 Formato Numeri

        I numeri devono essere in formato internazionale **senza** il prefisso +:
        - ✅ \`390000000000\` (Italia)
        - ✅ \`1234567890\` (USA)
        - ❌ \`+390000000000\`
        - ❌ \`00390000000000\`
      `,
      contact: {
        name: 'WhatsApp Proxy API',
        url: 'https://github.com/davide-vito-grammatica/whatsapp-mcp-gateway'
      },
      license: {
        name: 'ISC',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Server di sviluppo',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Use the API token for ordinary operations; admin token for QR, session, queue and configuration operations.' }
      },
      schemas: {
        // Schemas per le response
        StatusResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['connected', 'connecting', 'disconnected'],
              description: 'Stato della connessione WhatsApp'
            },
            message: {
              type: 'string',
              description: 'Messaggio descrittivo dello stato'
            },
            qr_code_available: {
              type: 'boolean',
              description: 'Whether a QR is available through the admin-protected management page'
            },
            authFiles: {
              type: 'string',
              enum: ['present', 'missing'],
              description: 'Presenza file di autenticazione'
            },
            connectionFailures: {
              type: 'integer',
              description: 'Numero di fallimenti consecutivi'
            }
          }
        },
        MessageRequest: {
          type: 'object',
          required: ['to', 'message'],
          properties: {
            to: {
              type: 'string',
              description: 'Numero destinatario (formato internazionale senza +)',
              example: '390000000000'
            },
            message: {
              type: 'string',
              description: 'Contenuto del messaggio da inviare (diventa caption se c\'è imageUrl)',
              example: 'Ciao! Questo è un messaggio di test.'
            },
            imageUrl: {
              type: 'string',
              format: 'uri',
              description: 'URL dell\'immagine da inviare (opzionale)',
              example: 'https://example.com/image.jpg'
            }
          }
        },
        MessageResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              description: 'Indica se il messaggio è stato inviato con successo'
            },
            message: {
              type: 'string',
              description: 'Messaggio di conferma'
            },
            messageId: {
              type: 'string',
              description: 'ID univoco del messaggio inviato'
            },
            to: {
              type: 'string',
              description: 'Numero destinatario'
            },
            messageType: {
              type: 'string',
              enum: ['text', 'image'],
              description: 'Tipo di messaggio inviato'
            },
            hasImage: {
              type: 'boolean',
              description: 'Indica se il messaggio include un\'immagine'
            }
          }
        },
        KeepAliveStatus: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'Se il keep-alive è abilitato in configurazione'
            },
            running: {
              type: 'boolean',
              description: 'Se il timer keep-alive è attualmente attivo'
            },
            intervalMinutes: {
              type: 'integer',
              description: 'Intervallo in minuti tra messaggi keep-alive'
            },
            groupId: {
              type: 'string',
              description: 'ID del gruppo WhatsApp per keep-alive'
            },
            customMessage: {
              type: 'string',
              description: 'Messaggio personalizzato per keep-alive'
            },
            connectionStatus: {
              type: 'string',
              enum: ['connected', 'connecting', 'disconnected'],
              description: 'Stato connessione WhatsApp'
            }
          }
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            message: {
              type: 'string',
              description: 'Messaggio di conferma'
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Descrizione dell\'errore'
            },
            details: {
              type: 'string',
              description: 'Dettagli tecnici dell\'errore'
            }
          }
        }
      }
    }
  },
  apis: [
    './src/server/app.js',     // File principale con tutte le route e annotazioni
    './src/server/*.js',       // Tutti i file JS nella directory server
    './index.js'               // File entry point
  ], // Path ai file contenenti le annotazioni JSDoc
};

const specs = swaggerJsdoc(options);

module.exports = specs;
