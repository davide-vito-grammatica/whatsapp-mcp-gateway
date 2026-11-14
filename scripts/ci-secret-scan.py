"""Run the pinned upstream scanner; never emit unredacted findings."""
import hashlib
import io
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = '8.30.1'
SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_linux_x64.tar.gz'
with urllib.request.urlopen(url, timeout=60) as response:
    data = response.read()
if hashlib.sha256(data).hexdigest() != SHA256:
    raise SystemExit('Gitleaks archive checksum mismatch')
with tempfile.TemporaryDirectory(prefix='whatsapp-ci-gitleaks-') as work:
    binary = Path(work) / 'gitleaks'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        binary.write_bytes(archive.extractfile('gitleaks').read())
    binary.chmod(0o700)
    subprocess.run([str(binary), 'git', '.', '--log-opts=--all', '--redact=100'], check=True)
