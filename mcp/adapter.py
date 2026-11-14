"""Fixed-endpoint adapter. WhatsApp/session/normalization belong to the proxy."""
import ipaddress
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ProxyAPI:
    def __init__(self, origin, timeout=45, image_hosts=(), api_token=None):
        url = urlsplit(origin)
        if url.scheme != 'http' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError('WHATSAPP_API_URL must be the private HTTP service origin.')
        if not api_token or len(api_token) < 32:
            raise ValueError('A separate backend API token is required.')
        self.api_token = api_token
        self.origin = origin.rstrip('/')
        self.timeout = timeout
        self.image_hosts = {host.strip().lower() for host in image_hosts if host.strip()}
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def _request(self, path, payload=None):
        # Never follow redirects, use ambient proxies, retry, or accept caller paths.
        request = Request(self.origin + path,
                          data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
                          headers={'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.api_token})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                body = response.read(65537)
                if len(body) > 65536:
                    raise ValueError('Oversized API response')
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError('Invalid API response')
                return response.status, data
        except HTTPError as error:
            # Do not return arbitrary upstream text, URLs, credentials or QR data.
            return error.code, {}

    def status(self):
        try:
            code, data = self._request('/status')
            if code != 200 or data.get('status') not in {'connected', 'connecting', 'disconnected'}:
                raise ValueError('Invalid status')
            result = {'success': True, 'connection_status': data['status'],
                      'session_status': data.get('sessionHealth') if data.get('sessionHealth') in {'good', 'critical'} else 'unknown'}
            diagnostic = {}
            for field in ('sessionErrors', 'lastSessionReset', 'timeSinceLastReset'):
                value = data.get(field)
                if type(value) in (int, float) and value >= 0:
                    diagnostic[field] = value
            config = data.get('sessionConfig', {})
            if isinstance(config, dict):
                for field in ('maxSessionErrors', 'resetCooldownMinutes'):
                    value = config.get(field)
                    if type(value) in (int, float) and value >= 0:
                        diagnostic[field] = value
                if type(config.get('autoRecoveryEnabled')) is bool:
                    diagnostic['autoRecoveryEnabled'] = config['autoRecoveryEnabled']
            result['diagnostics'] = diagnostic
            return result
        except (URLError, TimeoutError, OSError, ValueError):
            return {'success': False, 'connection_status': 'unknown', 'session_status': 'unknown',
                    'diagnostics': {}, 'error': 'Stato API WhatsApp non disponibile o risposta non valida.'}

    def validate_image(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None, 443):
            raise ValueError('Usare un URL HTTPS senza credenziali, frammenti o porte alternative.')
        if parsed.hostname.lower() not in self.image_hosts:
            raise ValueError('Host immagine non autorizzato: configurare MCP_IMAGE_ALLOWED_HOSTS con domini fidati.')
        if parsed.hostname.lower() in {'localhost'} or parsed.hostname.lower().endswith(('.local', '.localhost')):
            raise ValueError('Host immagine locale non consentito.')
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            return
        if not address.is_global:
            raise ValueError('Indirizzo immagine privato non consentito.')

    def channels(self, channel_id=None, query=None):
        from urllib.parse import quote
        path = '/channels/' + quote(channel_id, safe='') if channel_id is not None else '/channels'
        if query is not None:
            path += '?query=' + quote(query, safe='')
        try:
            code, data = self._request(path)
            if code == 200 and data.get('success') is True:
                # The dedicated proxy API emits only sanitized newsletter metadata.
                fields = ('success', 'channel') if channel_id is not None else ('success', 'channels', 'inventory_complete', 'inventory_source', 'truncated', 'unavailable_count', 'limitation')
                return {key: data[key] for key in fields if key in data}
            return {'success': False, 'error': f'Metadata canali non disponibili (HTTP {code}).'}
        except (URLError, TimeoutError, OSError, ValueError):
            return {'success': False, 'error': 'Metadata canali non disponibili; nessun invio effettuato.'}

    def send_channel(self, channel_id, message, image_url=None, token=None):
        import re
        if not re.fullmatch(r'[1-9][0-9]{5,29}@newsletter', channel_id):
            raise ValueError('ID canale non valido: richiesto un JID @newsletter, non un numero o gruppo.')
        if token is not None:
            if not re.fullmatch(r'[a-f0-9]{64}', token):
                raise ValueError('Invalid staged media token')
            image_url = 'http://whatsapp-mcp:8766/media/' + token
        elif image_url is not None:
            self.validate_image(image_url)
        result = {'success': False, 'recipient': channel_id, 'channel_id': channel_id, 'messageId': None,
                  'queued': False, 'delivery_status': 'not_sent'}
        payload = {'channel_id': channel_id, 'message': message}
        if image_url is not None:
            payload['imageUrl'] = image_url
        try:
            code, data = self._request('/channels/send-message', payload)
            if code == 200 and data.get('success') is True:
                result.update(success=True, delivery_status='submitted')
                if isinstance(data.get('messageId'), str):
                    result['messageId'] = data['messageId'][:256]
                result['note'] = 'Accettato dal trasporto, non conferma di pubblicazione/lettura; nessun retry.'
            elif code == 202 and data.get('queued') is True:
                result.update(queued=True, delivery_status='queued', error='Invio accodato: non ripetere.')
            else:
                result.update(delivery_status='rejected' if 400 <= code < 500 else 'unknown',
                    error='Account non amministratore o ruolo non disponibile.' if code == 403 else f'Invio canale non confermato (HTTP {code}); non ripetere automaticamente.')
        except (URLError, TimeoutError, OSError, ValueError):
            result.update(delivery_status='unknown', error='Invio non confermato; potrebbe essere avvenuto. Nessun retry: verificare prima di ripetere.')
        return result

    def send_staged(self, phone_number, caption, token):
        # Internal URLs are constructed here, never accepted as caller image_url.
        import re
        if not re.fullmatch(r'[a-f0-9]{64}', token):
            raise ValueError('Invalid staged media token')
        return self._send_payload(phone_number, caption, 'http://whatsapp-mcp:8766/media/' + token)

    def send(self, phone_number, message, image_url=None):
        if image_url is not None:
            self.validate_image(image_url)
        return self._send_payload(phone_number, message, image_url)

    def _send_payload(self, phone_number, message, image_url=None):
        result = {'success': False, 'recipient': phone_number, 'messageId': None,
                  'queued': False, 'delivery_status': 'not_sent'}
        try:
            # Preserve the original phone string. Only the existing proxy normalizes it.
            payload = {'to': phone_number, 'message': message}
            if image_url is not None:
                payload['imageUrl'] = image_url
            code, data = self._request('/send-message', payload)
            if code == 200 and data.get('success') is True:
                result.update(success=True, delivery_status='sent')
                if isinstance(data.get('to'), str):
                    result['recipient'] = data['to'][:80]
                if isinstance(data.get('messageId'), str):
                    result['messageId'] = data['messageId'][:256]
            elif code == 202 and data.get('queued') is True:
                result.update(queued=True, delivery_status='queued',
                              error='Invio accodato dal proxy: verrà ritentato automaticamente. Non ripetere la richiesta.')
                if isinstance(data.get('queueId'), str):
                    result['queueId'] = data['queueId'][:256]
            else:
                result.update(delivery_status='unknown' if code >= 500 or code < 400 else 'rejected',
                              error=f'API WhatsApp: HTTP {code}. Nessun retry MCP; verificare stato e coda prima di ripetere.')
        except ValueError:
            result['error'] = 'URL immagine non valido/autorizzato oppure risposta API non valida; verificare configurazione e stato prima di ripetere.'
            # A malformed response could follow a real send.
            result['delivery_status'] = 'unknown'
        except (URLError, TimeoutError, OSError):
            result.update(delivery_status='unknown',
                          error='API WhatsApp non raggiungibile o timeout. Invio non confermato; potrebbe essere avvenuto/accodato. Non ripetere senza verifica.')
        return result
