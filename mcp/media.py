"""Bounded, ephemeral image staging. No user paths, public storage or URL proxy."""
import http.client
import ipaddress
import os
import re
import secrets
import socket
import ssl
import threading
import time
import warnings
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

MIMES = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}
ROOT = '/tmp/whatsapp-mcp-media'
DOWNLOAD_SECONDS = 30
MAX_PIXELS = 8_000_000
TOKEN = re.compile(r'^[a-f0-9]{64}$')


class OpenAIFile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    download_url: str = Field(min_length=1, max_length=8192)
    file_id: str = Field(min_length=1, max_length=512)
    mime_type: str = Field(default='', max_length=128)
    file_name: str = Field(default='', max_length=512)


class MediaError(ValueError):
    pass


def public_target(url):
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.port not in (None, 443) or parsed.fragment
                or any(ord(c) <= 32 or ord(c) == 127 for c in url)):
            raise MediaError('Il download del file richiede un URL HTTPS pubblico senza credenziali o redirect.')
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise MediaError('Destinazione di download privata o non autorizzata.')
        return parsed, addresses[0][4][0]
    except (OSError, ValueError) as error:
        if isinstance(error, MediaError):
            raise
        raise MediaError('URL di download non valido o DNS non disponibile.') from None


class PinnedHTTPS(http.client.HTTPSConnection):
    """Connect to the validated IP; preserve TLS SNI/hostname verification."""
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


@contextmanager
def download_response(url):
    parsed, address = public_target(url)
    connection = PinnedHTTPS(parsed.hostname, address, DOWNLOAD_SECONDS)
    try:
        path = parsed.path or '/'
        if parsed.query:
            path += '?' + parsed.query
        connection.request('GET', path, headers={'Accept': 'image/jpeg,image/png,image/webp',
                                                 'Accept-Encoding': 'identity'})
        response = connection.getresponse()
        yield response
    finally:
        connection.close()


def verify_image(path, declared_mime, remote_mime):
    # Decode the actual bytes, restricted to supported formats and bounded pixels.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path, formats=list(MIMES)) as image:
                mime = MIMES[image.format]
                if image.width * image.height > MAX_PIXELS or getattr(image, 'n_frames', 1) != 1:
                    raise MediaError('Immagine troppo grande in pixel o animata; usare un’immagine statica entro 8 MP.')
                image.verify()
            with Image.open(path, formats=list(MIMES)) as image:
                image.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombWarning,
            Image.DecompressionBombError):
        raise MediaError('Il file non contiene un’immagine JPEG, PNG o WebP valida (statica, massimo 8 MP).') from None
    if declared_mime and declared_mime != mime:
        raise MediaError('MIME del file diverso dal contenuto effettivo.')
    if remote_mime and remote_mime not in {mime, 'application/octet-stream'}:
        raise MediaError('Content-Type remoto diverso dal contenuto immagine.')
    return mime


@dataclass
class Entry:
    path: Path
    mime: str
    size: int
    expires: float


class MediaStore:
    def __init__(self, max_bytes=15 * 1024 * 1024, ttl=300, root=ROOT, clock=time.monotonic):
        if not 1 <= max_bytes <= 20 * 1024 * 1024 or not 60 <= ttl <= 3600:
            raise ValueError('MCP_IMAGE_MAX_BYTES: 1..20971520; MCP_IMAGE_TTL_SECONDS: 60..3600.')
        self.max_bytes, self.ttl, self.clock = max_bytes, ttl, clock
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.entries, self.active = {}, set()
        self.lock = threading.Lock()
        # This private tmpfs has no persistent state. Clean remnants of a process crash.
        for path in self.root.iterdir():
            if TOKEN.fullmatch(path.name) and path.is_file():
                path.unlink()

    def cleanup(self):
        with self.lock:
            for token, entry in list(self.entries.items()):
                if entry.expires <= self.clock():
                    entry.path.unlink(missing_ok=True)
                    del self.entries[token]

    def remove(self, token):
        with self.lock:
            entry = self.entries.pop(token, None)
            if entry:
                entry.path.unlink(missing_ok=True)

    def stage(self, file):
        if file.mime_type and file.mime_type not in MIMES.values():
            raise MediaError('MIME non supportato: usare image/jpeg, image/png o image/webp.')
        self.cleanup()
        token = secrets.token_hex(32)
        registered = False
        with self.lock:
            if len(self.entries) + len(self.active) >= 3:
                raise MediaError('Storage temporaneo occupato; attendere il cleanup prima di una nuova richiesta.')
            self.active.add(token)
        path = self.root / token
        started = self.clock()
        try:
            with path.open('xb') as output, download_response(file.download_url) as response:
                os.chmod(path, 0o600)
                if response.status != 200:
                    raise MediaError('Download del file fallito; URL scaduto, errore HTTP o redirect non consentito.')
                if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                    raise MediaError('Download compresso non supportato.')
                length = response.getheader('Content-Length')
                if length and (not length.isdecimal() or int(length) > self.max_bytes):
                    raise MediaError('File oltre MCP_IMAGE_MAX_BYTES o dimensione non valida.')
                remote_mime = response.getheader('Content-Type', '').split(';')[0].strip().lower()
                size = 0
                while True:
                    if self.clock() - started >= DOWNLOAD_SECONDS:
                        raise MediaError('Timeout durante il download del file.')
                    # read1 does not wait to fill a chunk; refresh the remaining
                    # time budget so slow streaming cannot reset the deadline.
                    if response.fp is not None:
                        response.fp.raw._sock.settimeout(max(0.1, DOWNLOAD_SECONDS - (self.clock() - started)))
                    chunk = response.read1(min(65536, self.max_bytes - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise MediaError('File oltre MCP_IMAGE_MAX_BYTES durante il download.')
                    output.write(chunk)
                if self.clock() - started >= DOWNLOAD_SECONDS:
                    raise MediaError('Timeout durante il download del file.')
                if not size or (length and size != int(length)):
                    raise MediaError('Download vuoto o incompleto.')
            mime = verify_image(path, file.mime_type, remote_mime)
            with self.lock:
                self.entries[token] = Entry(path, mime, size, self.clock() + self.ttl)
                registered = True
            return token
        except MediaError:
            path.unlink(missing_ok=True)
            raise
        except (OSError, http.client.HTTPException, ValueError):
            path.unlink(missing_ok=True)
            raise MediaError('Download del file non disponibile o timeout; richiedere un nuovo file ChatGPT.') from None
        finally:
            if not registered:
                path.unlink(missing_ok=True)
            with self.lock:
                self.active.discard(token)

    def open(self, token):
        if not TOKEN.fullmatch(token):
            return None
        self.cleanup()
        with self.lock:
            entry = self.entries.get(token)
            if entry is None:
                return None
            try:
                return entry.path.open('rb'), entry.mime, entry.size
            except FileNotFoundError:
                return None

    def close(self):
        with self.lock:
            for entry in self.entries.values():
                entry.path.unlink(missing_ok=True)
            self.entries.clear()


def proxy_addresses(origin):
    try:
        return {a[4][0] for a in socket.getaddrinfo(urlsplit(origin).hostname, None, type=socket.SOCK_STREAM)}
    except OSError:
        return set()
