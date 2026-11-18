/* No token, phone or pairing material is persisted in browser storage. */
(() => {
    const el = id => document.getElementById(id);
    let mode = 'qr', code = '', polling = false, generating = false, revision = 0;
    const errors = {
        admin_auth_not_configured: 'Pairing disabilitato: configura il token amministrativo sul server.',
        admin_unauthorized: 'Token amministrativo non valido.',
        invalid_phone_number: 'Inserisci il numero completo con prefisso internazionale.',
        session_already_registered: 'Credenziali già registrate: nessuna nuova associazione. Se revocate, serve una verifica amministrativa; non viene effettuato alcun reset automatico.',
        pairing_in_progress: 'Richiesta già in corso. Attendi.',
        pairing_code_active: 'Un codice è già disponibile: usa quello visualizzato.',
        pairing_rate_limited: 'Attendi prima di richiedere un altro codice.',
        socket_not_ready: 'Socket non pronto. Attendi la connessione o verifica lo stato del servizio.',
        pairing_timeout: 'Richiesta scaduta. Nessuna rigenerazione automatica; attendi prima di riprovare.',
        pairing_interrupted: 'Connessione interrotta durante la richiesta. Attendi la riconnessione.',
        pairing_request_failed: 'Richiesta rifiutata o fallita. Attendi prima di riprovare.',
        pairing_registration_rejected: 'WhatsApp ha rifiutato la richiesta di associazione. Il codice non è utilizzabile.',
        credentials_write_failed: 'Salvataggio credenziali fallito: verifica storage e log prima di riprovare.',
        pairing_reconnect_failed: 'Riconnessione fallita. Attendi prima di riprovare.',
        pairing_not_supported: 'La libreria installata non supporta il Pairing Code.'
    };
    async function admin(endpoint, body) {
        const response = await fetch('/admin/pairing/' + endpoint, {
            method: body ? 'POST' : 'GET', cache: 'no-store',
            headers: { Authorization: 'Bearer ' + el('admin-token').value,
                ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(errors[data.error] || 'Errore del servizio.');
        return data;
    }
    function clearCode() {
        code = ''; el('pairing-code').textContent = ''; el('copy').hidden = true; el('expiry').textContent = '';
    }
    function render(data) {
        clearCode();
        el('status').dataset.pairingError = String(data.state === 'failed' && !!data.lastError);
        code = data.code || '';
        el('pairing-code').textContent = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
        el('copy').hidden = !code;
        el('generate').disabled = generating || !data.canRequest;
        el('reconnect').hidden = !data.canReconnect || ['scheduled', 'connecting'].includes(data.recovery?.state);
        el('reconnect').disabled = generating;
        if (data.state === 'failed' && data.lastError?.kind === 'server_iq_error') {
            el('error').textContent = data.lastError.code === 429 ?
                'WhatsApp ha limitato i tentativi (429). Attendi prima di riprovare.' :
                'WhatsApp ha restituito un errore durante l’associazione (' + data.lastError.code + '). Il codice è stato invalidato.';
        }
        if (code) el('expiry').textContent = 'Inserisci subito il codice. Disponibile qui fino alle ' + new Date(data.expiresAt).toLocaleTimeString();
        const states = { connected: '✅ Connesso! Puoi chiudere questa pagina.', code_ready: 'In attesa di associazione dal telefono…',
            requesting: 'Richiesta del codice in corso…', expired: 'Codice scaduto. Puoi richiederne un altro manualmente.',
            timeout: errors.pairing_timeout, failed: errors.pairing_request_failed,
            reconnecting: 'Associazione in corso: riavvio della connessione…', interrupted: errors.pairing_interrupted };
        const reasons = { credentials_retained: 'Credenziali conservate ma non validate. Usa Riprendi connessione per un solo tentativo non distruttivo.',
            socket_disconnected: 'Socket disconnesso. Usa Riprendi connessione.', socket_not_ready: errors.socket_not_ready,
            pairing_in_progress: data.state === 'timeout' ? 'Richiesta scaduta. Usa Riprendi connessione per chiudere il socket bloccato.' : errors.pairing_in_progress, pairing_code_active: errors.pairing_code_active,
            pairing_rate_limited: errors.pairing_rate_limited };
        el('status').textContent = data.connection === 'connected' ? states.connected : reasons[data.unavailableReason] || states[data.state] ||
            (data.canRequest ? 'Pronto per generare il codice.' : 'In attesa del socket o del termine del limite richieste…');
        if (data.connection !== 'connected' && data.recovery?.state === 'scheduled') {
            el('status').textContent = 'Riconnessione automatica in attesa. Prossimo tentativo: ' +
                new Date(data.recovery.nextAttemptAt).toLocaleTimeString() + '. Credenziali conservate.';
        } else if (data.connection !== 'connected' && data.recovery?.state === 'connecting') {
            el('status').textContent = 'Riconnessione automatica in corso…';
        } else if (data.recovery?.state === 'blocked') {
            const blocked = { session_rejected: 'Sessione rifiutata da WhatsApp: verifica i dispositivi collegati. Nessun reset automatico.',
                connection_replaced: 'Sessione aperta da un altro client: verifica il conflitto prima di riprendere.',
                credentials_write_failed: 'Salvataggio credenziali non riuscito: verifica lo storage prima di riprendere.',
                manual_disconnect: 'Connessione interrotta manualmente. Usa Riprendi connessione per riaprirla.' };
            el('status').textContent = blocked[data.recovery.reason] || el('status').textContent;
        }
    }
    async function poll() {
        if (polling || generating || document.hidden) return;
        polling = true;
        const currentRevision = revision;
        try {
            if (mode === 'code') {
                if (!el('admin-token').value) {
                    el('status').textContent = 'Inserisci il token amministrativo per verificare lo stato.';
                    return;
                }
                const data = await admin('status');
                if (currentRevision === revision) render(data);
            } else {
                if (!el('admin-token').value) { el('status').textContent = 'Inserisci il token amministrativo.'; return; }
                const data = await admin('status');
                if (currentRevision !== revision) return;
                render(data);
                if (data.connection === 'connected') el('qr-image').hidden = true;
                else {
                    const qr = await fetch('/qr-code', { headers: { Authorization: 'Bearer ' + el('admin-token').value }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
                    if (qr.ok && currentRevision === revision) {
                        const page = new DOMParser().parseFromString(await qr.text(), 'text/html');
                        const src = page.querySelector('.qr-image')?.getAttribute('src');
                        if (src?.startsWith('data:image/png;base64,')) {
                            el('qr-image').src = src; el('qr-image').hidden = false;
                        } else el('qr-image').hidden = true;
                    } else el('qr-image').hidden = true;
                }
            }
            if (currentRevision === revision && !(mode === 'code' && el('status').dataset.pairingError === 'true')) el('error').textContent = '';
        } catch (error) {
            if (currentRevision === revision) {
                clearCode(); el('generate').disabled = true; el('reconnect').hidden = true;
                el('error').textContent = error.message;
            }
        } finally { polling = false; }
    }
    function select(next) {
        mode = next; revision++; clearCode();
        el('qr-panel').hidden = next !== 'qr'; el('code-panel').hidden = next !== 'code';
        el('qr-tab').setAttribute('aria-selected', String(next === 'qr'));
        el('code-tab').setAttribute('aria-selected', String(next === 'code'));
        el('error').textContent = ''; poll();
    }
    el('qr-tab').onclick = () => select('qr');
    el('code-tab').onclick = () => select('code');
    el('admin-token').oninput = () => { revision++; clearCode(); el('generate').disabled = true; };
    el('admin-token').onchange = poll;
    el('reconnect').onclick = async () => {
        generating = true; el('reconnect').disabled = true;
        try { render(await admin('reconnect', {})); el('error').textContent = ''; }
        catch (error) { el('error').textContent = error.message; }
        finally { generating = false; }
    };
    el('generate').onclick = async () => {
        const currentRevision = revision;
        generating = true; el('generate').disabled = true; el('error').textContent = '';
        try {
            const data = await admin('code', { phoneNumber: el('phone').value });
            if (currentRevision === revision) render(data);
        }
        catch (error) {
            if (currentRevision === revision) { clearCode(); el('error').textContent = error.message; }
        }
        finally { generating = false; }
    };
    el('copy').onclick = async () => {
        try { await navigator.clipboard.writeText(code); el('error').textContent = 'Codice copiato.'; }
        catch (_) { el('error').textContent = 'Seleziona e copia manualmente il codice (clipboard richiede HTTPS).'; }
    };
    el('qr-image').hidden = !el('qr-image').getAttribute('src').startsWith('data:');
    document.addEventListener('visibilitychange', poll);
    setInterval(poll, 3000); poll();
})();
