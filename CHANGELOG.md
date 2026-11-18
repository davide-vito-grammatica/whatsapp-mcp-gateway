# Changelog

## [3.0.1] - 2026-11-18

### Fixed

- Recover automatically from recoverable 500 closures without deleting session
  credentials. After five quick retries, continue at five-minute intervals.
- Retry initialization and socket-handshake failures, cancel stale retries after
  manual disconnect, and stop safely on credential-storage failure or explicit
  session rejection/conflict.
- Expose recovery diagnostics and show automatic recovery/action-required states
  in both pairing views; manual reconnect is no longer hidden in the code tab.

## [3.0.0] - 2026-11-14

### Breaking changes

- HTTP API and administrative routes require separate configured bearers; the MCP
  adapter uses its own backend token in addition to its external transport bearer.
- Node 24.19.0+ is required. The canonical MCP runtime is Python 3.13.
- Default Compose publishes no host ports; an explicit override exposes loopback.
- Multipart uploads are bounded to 10 MiB. JSON requests are bounded to 128 KiB.
- URL media fetching requires trusted HTTPS hosts and DNS/connection validation.
  Automatic text link previews are disabled. Test sends require an explicit recipient.
- Ambiguous submissions are not silently retried; v2 queues are isolated from
  historical legacy files and represent sent/queued/unknown outcomes explicitly.

### Added and updated

- Safe environment initialization, read-only status helper, source-build quickstart,
  private vulnerability reporting policy, contribution guide and dependency notices.
- Updated Baileys, native media, mail and Python dependencies; patched minimal
  runtime images and isolated image/credential checks.
- Read-only public/fork validation; explicit release publication reuses tested and
  scanned images and records registry-qualified digests.
- Public source snapshot begins with one root commit; historical operational
  material is excluded from this repository.

## Historical release notes

The notes below describe their original versions, not current limits or defaults.

## [2.3.0] - 2026-09-11

### Aggiunto

- Dead letter queue persistente per messaggi non inviati, inclusi allegati binari.
- Replay automatico e seriale dei messaggi in coda alla riconnessione WhatsApp.
- Endpoint per consultare e ritentare manualmente la coda.
- Test automatici Node.js per persistenza, retry e pulizia degli allegati in coda.

## [2.2.1] - 2026-08-28

### Corretto

- Ripristinata l'inizializzazione del transporter SMTP con l'API Nodemailer corretta.
- Mascherata la password SMTP dai log di configurazione.

## [2.2.0] - 2026-08-28

### Aggiunto

- Invio di documenti tramite URL con nome file, MIME type e caption opzionali.
- Endpoint `POST /send-message-upload` per inviare allegati binari con `multipart/form-data` (massimo 64 MB), inclusi PDF privati senza URL pubblico.
- Avvisi email opzionali per disconnessioni WhatsApp, ripetuti a un intervallo configurabile, e notifica di ripristino.
- Configurazione `disconnection_alert_interval_minutes` per la cadenza degli avvisi email.

### Corretto

- Il monitor di connessione ora riceve lo stato Baileys corretto e usa la configurazione SMTP.
- Corretto il contesto dei `COPY` nel Dockerfile, compatibile con la pipeline GHCR.
