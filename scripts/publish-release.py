"""Publish tested image bundles and metadata to a GitHub release; never log tokens."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

repo = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
token = os.environ['GHCR_TOKEN']
version = json.loads(Path('package.json').read_text())['version']
metadata = json.loads(Path('release-metadata.json').read_text())
assert metadata['commit'] == sha
bundle = Path(f'images-{version}-linux-amd64.tar.gz')
# These are the same local image objects already validated and pushed, not a rebuild.
with bundle.open('wb') as output:
    save = subprocess.Popen(['docker', 'save', f'ghcr.io/{repo.lower()}:{version}', f'ghcr.io/{repo.lower()}-mcp:{version}'], stdout=subprocess.PIPE)
    gzip = subprocess.run(['gzip', '-c'], stdin=save.stdout, stdout=output, check=True)
    save.stdout.close()
    if save.wait() != 0:
        raise SystemExit('Saving tested images failed')
checksums = []
for file in [bundle, Path('release-metadata.json')]:
    digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
    checksums.append(f'{digest}  {file.name}')
Path('SHA256SUMS').write_text('\n'.join(checksums) + '\n')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect())
def request(url, data, content_type='application/json'):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'api.github.com', 'uploads.github.com'}:
        raise ValueError('Unexpected release endpoint')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'User-Agent': 'whatsapp-gateway-release', 'Content-Type': content_type})
    with opener.open(req, timeout=180) as response:
        return json.load(response)

release = request(f'https://api.github.com/repos/{repo}/releases', json.dumps({
    'tag_name': 'v' + version, 'target_commitish': sha, 'name': version,
    'body': 'Tested linux/amd64 proxy and MCP images, source and digest metadata. '
            'Verify SHA256SUMS before docker load. See README and THIRD_PARTY_NOTICES.md.',
    'draft': False, 'prerelease': '-' in version}).encode())
endpoint = release['upload_url'].split('{', 1)[0]
for file in [bundle, Path('release-metadata.json'), Path('SHA256SUMS')]:
    content_type = 'application/gzip' if file.name.endswith('.gz') else 'application/octet-stream'
    request(endpoint + '?name=' + urllib.parse.quote(file.name), file.read_bytes(), content_type)
print('Published release assets:', release['html_url'])
