#!/bin/sh
set -e

echo "[entrypoint] Avvio entrypoint container..."

# Gestione configurazione sessione tramite variabili d'ambiente
CONFIG_FILE="/app/config/config.ini"

# Initialize a fresh named config volume once; never overwrite installed settings.
if [ ! -f "$CONFIG_FILE" ] && [ -f /app/default-config.ini ]; then
    mkdir -p /app/config
    cp /app/default-config.ini "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    if [ "$(id -u)" = "0" ]; then chown node:node "$CONFIG_FILE"; fi
fi

if [ -f "$CONFIG_FILE" ]; then
    echo "[entrypoint] File config trovato: $CONFIG_FILE"

    # Sovrascrivi configurazione sessione se le variabili d'ambiente sono definite
    if [ -n "$SESSION_MAX_ERRORS" ]; then
        echo "[entrypoint] Sovrascrivo max_session_errors = $SESSION_MAX_ERRORS"
        sed -i "s/^max_session_errors=.*/max_session_errors=$SESSION_MAX_ERRORS/" "$CONFIG_FILE"
    fi

    if [ -n "$SESSION_RESET_COOLDOWN" ]; then
        echo "[entrypoint] Sovrascrivo reset_cooldown_minutes = $SESSION_RESET_COOLDOWN"
        sed -i "s/^reset_cooldown_minutes=.*/reset_cooldown_minutes=$SESSION_RESET_COOLDOWN/" "$CONFIG_FILE"
    fi

    if [ -n "$SESSION_AUTO_RECOVERY" ]; then
        echo "[entrypoint] Sovrascrivo auto_recovery_enabled = $SESSION_AUTO_RECOVERY"
        sed -i "s/^auto_recovery_enabled=.*/auto_recovery_enabled=$SESSION_AUTO_RECOVERY/" "$CONFIG_FILE"
    fi

    echo "[entrypoint] Configurazione sessione aggiornata:"
    grep -A10 "\[session\]" "$CONFIG_FILE" || echo "Sezione [session] non trovata"
else
    echo "[entrypoint] ATTENZIONE: File config non trovato in $CONFIG_FILE"
fi

# Directory richieste
DATA_DIR="/app/data"
AUTH_DIR="$DATA_DIR/auth"
LOGS_DIR="$DATA_DIR/logs"

# Se siamo root possiamo sistemare permessi/ownership prima di droppare a 'node'
if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] Esecuzione come root: preparo directory e permessi"
  mkdir -p "$AUTH_DIR" "$LOGS_DIR" || true
  # Prepare writable directories without recursively changing existing credentials,
  # historical queues, or user data. Existing session ownership is preserved.
  chown node:node "$DATA_DIR" "$LOGS_DIR"
  if [ ! -e "$AUTH_DIR/creds.json" ]; then
    chown node:node "$AUTH_DIR"
  fi
  if [ -d "$DATA_DIR/outbox-v2" ]; then chmod -R go-rwx "$DATA_DIR/outbox-v2"; fi
else
  echo "[entrypoint] Non sono root (uid=$(id -u)), tenterò di creare directory se mancanti"
  mkdir -p "$AUTH_DIR" "$LOGS_DIR" || true
fi

# Se non riusciamo a creare i logs la logica applicativa farà fallback alla console
if [ ! -d "$LOGS_DIR" ]; then
  echo "[entrypoint] WARNING: impossibile creare $LOGS_DIR (permessi?). Continuerò comunque."
fi

echo "[entrypoint] Avvio applicazione come utente 'node'"
if [ "$(id -u)" = "0" ]; then
  # Usa su-exec (leggero) se disponibile, altrimenti fallback a su
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  else
    exec su node -c "exec $*"
  fi
else
  exec "$@"
fi
