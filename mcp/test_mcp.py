"""Real MCP protocol against a mocked HTTP WhatsApp API; no real recipient."""
import asyncio
import io
import tempfile
from contextlib import contextmanager
from pathlib import Path
from PIL import Image
from jsonschema import Draft202012Validator, ValidationError
from media import MediaStore, MediaError, OpenAIFile, public_target, ROOT
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch, Mock
from urllib.error import URLError

from starlette.testclient import TestClient
from adapter import ProxyAPI
from server import build_app


class FakeProxy(BaseHTTPRequestHandler):
    calls = []
    response = (200, {'success': True, 'to': '+39 000 000 0000', 'messageId': 'MOCK-ID'})
    media_client = None
    media_response = None
    status_code = 200
    status_data = {'status': 'connecting', 'sessionErrors': 0,
                   'qr_code_raw': 'SENSITIVE-QR', 'token': 'SENSITIVE-TOKEN',
                   'sessionConfig': {'maxSessionErrors': 5, 'autoRecoveryEnabled': True, 'secret': 'SENSITIVE'}}

    def log_message(self, *args):
        pass

    def respond(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer test-backend-' + 'y' * 40:
            return self.respond(401, {'error': 'unauthorized'})
        self.calls.append(('GET', self.path, None))
        self.respond(self.status_code, self.status_data)

    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer test-backend-' + 'y' * 40:
            return self.respond(401, {'error': 'unauthorized'})
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(('POST', self.path, body))
        if self.media_client is not None and body.get('imageUrl', '').startswith('http://whatsapp-mcp:8766/media/'):
            type(self).media_response = self.media_client.get(body['imageUrl'].removeprefix('http://whatsapp-mcp:8766'))
        self.respond(*self.response)


class MCPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), FakeProxy)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        FakeProxy.calls.clear()
        FakeProxy.media_client = None
        FakeProxy.media_response = None
        FakeProxy.response = (200, {'success': True, 'to': '+39 000 000 0000', 'messageId': 'MOCK-ID'})
        FakeProxy.status_code = 200
        self.env = patch.dict(os.environ, {'WHATSAPP_API_URL': self.origin, 'WHATSAPP_API_TOKEN': 'test-backend-' + 'y' * 40, 'MCP_AUTH_TOKEN': 'test-only-' + 'x' * 40,
                            'MCP_ALLOWED_HOSTS': 'testserver', 'MCP_IMAGE_ALLOWED_HOSTS': 'images.example.org'})
        self.env.start()
        self.client = TestClient(build_app())
        self.client.__enter__()
        self.headers = {'Authorization': 'Bearer ' + os.environ['MCP_AUTH_TOKEN'],
                        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        init = self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                      'clientInfo': {'name': 'test', 'version': '1.0'}})
        self.assertIn('protocolVersion', init)
        self.headers['MCP-Protocol-Version'] = init['protocolVersion']
        self.client.post('/mcp', headers=self.headers, json={'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()

    def rpc(self, method, params=None, headers=None):
        payload = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if params is not None:
            payload['params'] = params
        response = self.client.post('/mcp', headers=headers or self.headers, json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['result']

    def call(self, name, **arguments):
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        return result, result.get('structuredContent')

    def test_tool_list_annotations(self):
        tools = {t['name']: t for t in self.rpc('tools/list')['tools']}
        self.assertEqual(set(tools), {'get_whatsapp_status', 'send_whatsapp_message', 'send_whatsapp_image', 'list_whatsapp_channels', 'search_whatsapp_channels', 'get_whatsapp_channel', 'send_whatsapp_channel_message', 'send_whatsapp_channel_image'})
        self.assertTrue(tools['get_whatsapp_status']['annotations']['readOnlyHint'])
        for name in ('send_whatsapp_message', 'send_whatsapp_image'):
            self.assertFalse(tools[name]['annotations']['readOnlyHint'])
            self.assertFalse(tools[name]['annotations']['idempotentHint'])
            self.assertTrue(tools[name]['annotations']['openWorldHint'])
            self.assertIn('REALE', tools[name]['description'])

    def test_channel_schema_and_annotations(self):
        tools = {t['name']: t for t in self.rpc('tools/list')['tools']}
        for name in ('list_whatsapp_channels', 'search_whatsapp_channels', 'get_whatsapp_channel'):
            self.assertTrue(tools[name]['annotations']['readOnlyHint'])
        for name in ('send_whatsapp_channel_message', 'send_whatsapp_channel_image'):
            self.assertFalse(tools[name]['annotations']['readOnlyHint'])
            self.assertFalse(tools[name]['annotations']['idempotentHint'])
            self.assertIn('REALE', tools[name]['description'])
            self.assertIn('@newsletter', tools[name]['inputSchema']['properties']['channel_id']['pattern'])
        tool = tools['send_whatsapp_channel_image']
        self.assertEqual(tool['_meta'], {'openai/fileParams': ['file']})
        self.assertEqual(tool['inputSchema']['properties']['file']['type'], 'object')
        self.assertNotIn('file', tool['inputSchema']['required'])

    def test_channel_and_phone_ids_never_cross(self):
        for name, args in [('send_whatsapp_message', {'phone_number': '120363123456789@newsletter', 'message': 'test'}),
                           ('send_whatsapp_channel_message', {'channel_id': '+393331234567', 'message': 'test'}),
                           ('send_whatsapp_channel_message', {'channel_id': '120363123@g.us', 'message': 'test'}),
                           ('send_whatsapp_channel_message', {'channel_id': '120363123456789@newsletter', 'message': ' '})]:
            result, _ = self.call(name, **args)
            self.assertTrue(result['isError'])
        self.assertEqual(FakeProxy.calls, [])

    def test_channel_send_fixed_endpoint_once(self):
        _, data = self.call('send_whatsapp_channel_message', channel_id='120363123456789@newsletter', message='test')
        self.assertTrue(data['success'])
        self.assertEqual(data['delivery_status'], 'submitted')
        self.assertEqual(FakeProxy.calls, [('POST', '/channels/send-message', {'channel_id': '120363123456789@newsletter', 'message': 'test'})])

    def test_channel_error_no_retry(self):
        for code in (403, 500):
            FakeProxy.calls.clear()
            FakeProxy.response = (code, {'error': 'SENSITIVE'})
            _, data = self.call('send_whatsapp_channel_message', channel_id='120363123456789@newsletter', message='test')
            self.assertFalse(data['success'])
            self.assertFalse(data['queued'])
            self.assertEqual(len(FakeProxy.calls), 1)
            self.assertNotIn('SENSITIVE', json.dumps(data))

    def test_channel_read_fixed_routes(self):
        for name, args, path in [('list_whatsapp_channels', {}, '/channels'),
                                ('search_whatsapp_channels', {'query': 'Casa'}, '/channels?query=Casa'),
                                ('get_whatsapp_channel', {'channel_id': '120363123456789@newsletter'}, '/channels/120363123456789%40newsletter')]:
            FakeProxy.calls.clear()
            self.call(name, **args)
            self.assertEqual(FakeProxy.calls, [('GET', path, None)])

    def test_channel_image_xor_and_legacy_policy(self):
        base = {'channel_id': '120363123456789@newsletter'}
        file = {'download_url': 'https://example.invalid/test.png', 'file_id': 'file_test'}
        for args in ({}, {'file': file, 'image_url': 'https://images.example.org/x'},
                     {'file': None}, {'file': 'file_test'}, {'image_url': 'https://other.example.org/x'}):
            result, _ = self.call('send_whatsapp_channel_image', **base, **args)
            self.assertTrue(result['isError'])
        self.assertEqual(FakeProxy.calls, [])
        _, data = self.call('send_whatsapp_channel_image', **base, image_url='https://images.example.org/x', caption='test')
        self.assertTrue(data['success']); self.assertEqual(data['source'], 'image_url')
        self.assertEqual(FakeProxy.calls[0][1], '/channels/send-message')

    def test_channel_image_file_mocked_download(self):
        file = {'download_url': 'https://example.invalid/test.png', 'file_id': 'file_test', 'mime_type': 'image/png', 'file_name': 'test.png'}
        token = 'a' * 64
        with patch('server.MediaStore.stage', return_value=token) as stage, patch('server.MediaStore.remove') as remove:
            _, data = self.call('send_whatsapp_channel_image', channel_id='120363123456789@newsletter', file=file, caption='test')
            self.assertTrue(data['success']); self.assertEqual(data['source'], 'file')
            self.assertIsInstance(stage.call_args.args[0], OpenAIFile)
            remove.assert_called_once_with(token)
            self.assertEqual(FakeProxy.calls[0][2]['imageUrl'], 'http://whatsapp-mcp:8766/media/' + token)

    def test_status_no_auth_material(self):
        result, data = self.call('get_whatsapp_status')
        self.assertFalse(result.get('isError', False))
        self.assertEqual(data['connection_status'], 'connecting')
        self.assertEqual(data['session_status'], 'unknown')
        self.assertNotIn('SENSITIVE', json.dumps(result))
        self.assertEqual(FakeProxy.calls, [('GET', '/status', None)])

    def test_text_preserves_number_and_message(self):
        result, data = self.call('send_whatsapp_message', phone_number='+39 000 000 0000', message='Ciao 🌍')
        self.assertTrue(data['success'])
        self.assertEqual(data['messageId'], 'MOCK-ID')
        self.assertEqual(FakeProxy.calls, [('POST', '/send-message', {'to': '+39 000 000 0000', 'message': 'Ciao 🌍'})])

    def test_image_payload(self):
        _, data = self.call('send_whatsapp_image', phone_number='+39 000 000 0000',
                            image_url='https://images.example.org/photo.png', caption='Caption')
        self.assertTrue(data['success'])
        self.assertEqual(FakeProxy.calls[0][2], {'to': '+39 000 000 0000', 'message': 'Caption', 'imageUrl': 'https://images.example.org/photo.png'})

    def test_queue_is_not_reported_as_sent(self):
        FakeProxy.response = (202, {'success': False, 'queued': True, 'queueId': 'MOCK-QUEUE', 'details': 'SENSITIVE'})
        result, data = self.call('send_whatsapp_message', phone_number='3331234567', message='Test')
        self.assertTrue(result['isError'])
        self.assertFalse(data['success'])
        self.assertTrue(data['queued'])
        self.assertEqual(data['delivery_status'], 'queued')
        self.assertEqual(data['queueId'], 'MOCK-QUEUE')
        self.assertEqual(len(FakeProxy.calls), 1)
        self.assertNotIn('SENSITIVE', json.dumps(result))

    def test_upstream_failure_does_not_retry_or_leak(self):
        FakeProxy.response = (500, {'error': 'SENSITIVE'})
        result, data = self.call('send_whatsapp_message', phone_number='3331234567', message='Test')
        self.assertTrue(result['isError'])
        self.assertEqual(data['delivery_status'], 'unknown')
        self.assertEqual(len(FakeProxy.calls), 1)
        self.assertNotIn('SENSITIVE', json.dumps(result))

    def test_media_and_ambiguous_http_errors_never_retry(self):
        for status, expected in ((424, 'rejected'), (502, 'unknown')):
            with self.subTest(status=status):
                FakeProxy.calls.clear()
                FakeProxy.response = (status, {'error': 'SENSITIVE'})
                result, data = self.call('send_whatsapp_image', phone_number='3331234567',
                                         image_url='https://images.example.org/photo.png', caption='Test')
                self.assertTrue(result['isError'])
                self.assertEqual(data['delivery_status'], expected)
                self.assertFalse(data['queued'])
                self.assertEqual(len(FakeProxy.calls), 1)
                self.assertNotIn('SENSITIVE', json.dumps(result))

    def test_invalid_inputs_never_reach_proxy(self):
        cases = [('send_whatsapp_message', {'phone_number': '120363123@g.us', 'message': 'test'}),
                 ('send_whatsapp_message', {'phone_number': '3331234567', 'message': '   '}),
                 ('send_whatsapp_message', {'phone_number': 3331234567, 'message': 'test'}),
                 ('send_whatsapp_message', {'phone_number': '3331234567', 'message': ''}),
                 ('send_whatsapp_image', {'phone_number': '3331234567', 'image_url': 'http://127.0.0.1/private'}),
                 ('send_whatsapp_image', {'phone_number': '3331234567', 'image_url': 'https://other.example.org/image'}),
                 ('send_whatsapp_image', {'phone_number': '3331234567', 'image_url': 'https://user:pass@images.example.org/image'})]
        for name, args in cases:
            with self.subTest(name=name, args=args):
                result, _ = self.call(name, **args)
                self.assertTrue(result['isError'])
        self.assertEqual(FakeProxy.calls, [])

    def test_auth_host_origin_and_discovery(self):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
        self.assertEqual(self.client.post('/mcp', json=body).status_code, 401)
        self.assertEqual(self.client.get('/.well-known/oauth-protected-resource/mcp').status_code, 404)
        self.assertEqual(self.client.post('/mcp', headers={**self.headers, 'Host': 'evil.example'}, json=body).status_code, 421)
        self.assertEqual(self.client.post('/mcp', headers={**self.headers, 'Origin': 'https://evil.example'}, json=body).status_code, 403)
        self.assertEqual(FakeProxy.calls, [])

    def test_health_reports_api_unavailable(self):
        FakeProxy.status_code = 503
        self.assertEqual(self.client.get('/health').status_code, 503)

    def test_network_failure_unknown_delivery(self):
        api = ProxyAPI(self.origin, api_token='test-backend-' + 'y' * 40)
        with patch.object(api.opener, 'open', side_effect=URLError('SENSITIVE')) as request:
            data = api.send('3331234567', 'test')
        self.assertEqual(data['delivery_status'], 'unknown')
        self.assertNotIn('SENSITIVE', json.dumps(data))
        request.assert_called_once()

    def test_no_redirect_to_other_api(self):
        FakeProxy.response = (302, {'secret': 'SENSITIVE'})
        _, data = self.call('send_whatsapp_message', phone_number='3331234567', message='Test')
        self.assertFalse(data['success'])
        self.assertEqual(len(FakeProxy.calls), 1)

    def test_file_schema(self):
        tool = next(t for t in self.rpc('tools/list')['tools'] if t['name'] == 'send_whatsapp_image')
        self.assertEqual(tool['_meta']['openai/fileParams'], ['file'])
        schema = tool['inputSchema']
        file_schema = schema['properties']['file']
        self.assertEqual(file_schema['type'], 'object')
        self.assertNotIn('default', file_schema)
        self.assertNotIn('null', json.dumps(file_schema))
        self.assertNotIn('file', schema['required'])
        self.assertNotIn('$ref', file_schema)
        self.assertNotIn('anyOf', file_schema)
        for prop in ('download_url', 'file_id', 'mime_type', 'file_name'):
            self.assertEqual(file_schema['properties'][prop]['type'], 'string')
        validator = Draft202012Validator(schema)
        validator.validate({'phone_number': '+390000000000', 'file': {'download_url': 'https://example.invalid/test.png', 'file_id': 'file_test'}})
        for invalid_file in (None, 'file_test', {'file_id': 'file_test'}, {'download_url': 'https://example.invalid/test.png'}):
            with self.assertRaises(ValidationError):
                validator.validate({'phone_number': '+390000000000', 'file': invalid_file})
        self.assertEqual(set(file_schema['required']), {'download_url', 'file_id'})
        self.assertEqual(set(file_schema['properties']), {'download_url', 'file_id', 'mime_type', 'file_name'})
        self.assertEqual(schema['required'], ['phone_number'])
        self.assertIn('image_url', schema['properties'])

    def test_requested_file_object_payload_with_mocked_download(self):
        requested = {'download_url': 'https://example.invalid/test.png', 'file_id': 'file_test',
                     'mime_type': 'image/png', 'file_name': 'test.png'}
        with patch('media.download_response', side_effect=lambda url: fake_download(image_bytes('PNG'))) as download:
            result, data = self.call('send_whatsapp_image', phone_number='+390000000000',
                                    file=requested, caption='test')
        self.assertFalse(result.get('isError', False))
        self.assertTrue(data['success'])
        self.assertEqual(data['source'], 'file')
        download.assert_called_once_with(requested['download_url'])
        self.assertEqual(FakeProxy.calls[0][2]['to'], '+390000000000')
        self.assertEqual(FakeProxy.calls[0][2]['message'], 'test')

    def test_file_string_rejected_without_proxy_or_download(self):
        with patch('media.download_response') as download:
            result, _ = self.call('send_whatsapp_image', phone_number='+390000000000', file='file_test')
        self.assertTrue(result['isError'])
        download.assert_not_called()
        self.assertEqual(FakeProxy.calls, [])

    def test_file_null_rejected_even_with_legacy_url(self):
        for extra in ({}, {'image_url': 'https://images.example.org/photo.png'}):
            with patch('media.download_response') as download:
                result, _ = self.call('send_whatsapp_image', phone_number='+390000000000', file=None, **extra)
            self.assertTrue(result['isError'])
            download.assert_not_called()
        self.assertEqual(FakeProxy.calls, [])

    def test_file_flow_proxy_fetch_and_immediate_cleanup(self):
        blob = image_bytes('PNG')
        FakeProxy.media_client = self.client
        with patch('media.download_response', side_effect=lambda url: fake_download(blob)), patch('server.proxy_addresses', return_value={'testclient'}):
            _, data = self.call('send_whatsapp_image', phone_number='3331234567', caption='mock caption',
                                file={'download_url': 'https://files.example/image', 'file_id': 'file-test',
                                      'mime_type': 'image/png', 'file_name': '../../escape.png'})
        self.assertTrue(data['success'])
        self.assertEqual(data['source'], 'file')
        self.assertEqual(data['messageId'], 'MOCK-ID')
        response = FakeProxy.media_response
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, blob)
        self.assertEqual(response.headers['content-type'], 'image/png')
        self.assertEqual(response.headers['content-length'], str(len(blob)))
        self.assertEqual(response.headers['cache-control'], 'no-store')
        payload = FakeProxy.calls[0][2]
        self.assertEqual(payload['message'], 'mock caption')
        with patch('server.proxy_addresses', return_value={'testclient'}):
            self.assertEqual(self.client.get(payload['imageUrl'].removeprefix('http://whatsapp-mcp:8766')).status_code, 404)

    def test_file_queue_keeps_bounded_ttl(self):
        FakeProxy.response = (202, {'queued': True, 'queueId': 'MOCK-QUEUE'})
        with patch('media.download_response', side_effect=lambda url: fake_download(image_bytes('JPEG'))):
            _, data = self.call('send_whatsapp_image', phone_number='3331234567', file={'download_url': 'https://files.example/image', 'file_id': 'file-test'})
        self.assertTrue(data['queued'])
        self.assertFalse(data['success'])
        self.assertEqual(data['source'], 'file')
        self.assertEqual(data['media_expires_in_seconds'], 300)

    def test_file_proxy_rejection_cleanup(self):
        FakeProxy.response = (400, {})
        with patch('media.download_response', side_effect=lambda url: fake_download(image_bytes('PNG'))):
            _, data = self.call('send_whatsapp_image', phone_number='3331234567', file={'download_url': 'https://files.example/image', 'file_id': 'file-test'})
        self.assertEqual(data['delivery_status'], 'rejected')
        self.assertEqual(data['source'], 'file')
        with patch('server.proxy_addresses', return_value={'testclient'}):
            self.assertEqual(self.client.get(FakeProxy.calls[0][2]['imageUrl'].removeprefix('http://whatsapp-mcp:8766')).status_code, 404)

    def test_file_unknown_delivery_retains_until_cleanup(self):
        with patch('media.download_response', side_effect=lambda url: fake_download(image_bytes('PNG'))), patch('adapter.ProxyAPI._request', side_effect=TimeoutError):
            _, data = self.call('send_whatsapp_image', phone_number='3331234567', file={'download_url': 'https://files.example/image', 'file_id': 'file-test'})
        self.assertFalse(data['success'])
        self.assertEqual(data['delivery_status'], 'unknown')
        self.assertEqual(data['media_expires_in_seconds'], 300)

    def test_file_download_failure_never_reaches_proxy(self):
        with patch('media.download_response', side_effect=TimeoutError('SECRET URL')):
            result, data = self.call('send_whatsapp_image', phone_number='3331234567', file={'download_url': 'https://files.example/image', 'file_id': 'file-test'})
        self.assertTrue(result['isError'])
        self.assertEqual(data['source'], 'file')
        self.assertNotIn('SECRET', json.dumps(data))
        self.assertEqual(FakeProxy.calls, [])

    def test_ambiguous_or_missing_source(self):
        for args in ({}, {'file': {'download_url': 'https://files.example/image', 'file_id': 'file-test'}, 'image_url': 'https://images.example.org/image'}):
            result, data = self.call('send_whatsapp_image', phone_number='3331234567', **args)
            self.assertTrue(result['isError'])
            self.assertEqual(data['delivery_status'], 'not_sent')
        self.assertEqual(FakeProxy.calls, [])

    def test_media_peer_token_and_path_traversal(self):
        with patch('server.proxy_addresses', return_value={'testclient'}):
            for path in ('/media/' + 'a' * 64, '/media/%2e%2e%2fetc%2fpasswd', '/media/invalid'):
                self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get('/media/' + 'a' * 64).status_code, 404)
        self.assertEqual(self.client.post('/media/' + 'a' * 64).status_code, 401)


def image_bytes(format):
    output = io.BytesIO()
    Image.new('RGB', (2, 2), 'red').save(output, format)
    return output.getvalue()


@contextmanager
def fake_download(blob, status=200, mime='application/octet-stream', length=None, encoding='identity'):
    response = io.BytesIO(blob)
    response.status = status
    response.fp = Mock()
    headers = {'Content-Type': mime, 'Content-Encoding': encoding}
    if length is not None:
        headers['Content-Length'] = str(length)
    response.getheader = lambda name, default=None: headers.get(name, default)
    yield response


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 100.0
        self.store = MediaStore(root=self.temp.name, ttl=60, clock=lambda: self.now)
        self.file = OpenAIFile(download_url='https://files.example/image', file_id='file-test')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def stage(self, blob, **kwargs):
        with patch('media.download_response', side_effect=lambda url: fake_download(blob, **kwargs)):
            return self.store.stage(self.file)

    def test_jpeg_png_webp_content_detection(self):
        for format, mime in [('JPEG', 'image/jpeg'), ('PNG', 'image/png'), ('WEBP', 'image/webp')]:
            token = self.stage(image_bytes(format))
            handle, actual, size = self.store.open(token)
            with handle:
                self.assertEqual(handle.read(), image_bytes(format))
            self.assertEqual(actual, mime)
            self.assertEqual(size, len(image_bytes(format)))
            self.store.remove(token)

    def test_mime_spoofing_and_disallowed(self):
        for declared in ('text/html', 'image/jpeg'):
            self.file.mime_type = declared
            with self.assertRaises(MediaError):
                self.stage(image_bytes('PNG'))
        self.file.mime_type = ''
        with self.assertRaises(MediaError):
            self.stage(image_bytes('PNG'), mime='text/html')
        with self.assertRaises(MediaError):
            self.stage(b'not an image', mime='image/png')
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_size_limit_header_and_stream(self):
        self.store.max_bytes = 10
        for kwargs in ({'length': 100}, {}):
            with self.assertRaises(MediaError):
                self.stage(image_bytes('PNG'), **kwargs)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_http_failure_redirect_empty_and_incomplete(self):
        for blob, kwargs in [(image_bytes('PNG'), {'status': 500}), (b'', {}),
                             (image_bytes('PNG'), {'status': 302}), (image_bytes('PNG'), {'length': 1000}),
                             (image_bytes('PNG'), {'encoding': 'gzip'})]:
            with self.assertRaises(MediaError):
                self.stage(blob, **kwargs)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_timeout_and_safe_error_cleanup(self):
        with patch('media.download_response', side_effect=TimeoutError('SECRET')):
            with self.assertRaises(MediaError) as error:
                self.store.stage(self.file)
        self.assertNotIn('SECRET', str(error.exception))
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_stream_deadline(self):
        @contextmanager
        def delayed(url):
            with fake_download(image_bytes('PNG')) as response:
                self.now += 31
                yield response
        with patch('media.download_response', side_effect=delayed):
            with self.assertRaises(MediaError):
                self.store.stage(self.file)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_pixel_bound_and_corrupt_image(self):
        with patch('media.MAX_PIXELS', 1):
            with self.assertRaises(MediaError):
                self.stage(image_bytes('PNG'))
        with self.assertRaises(MediaError):
            self.stage(image_bytes('JPEG')[:40])
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_unexpected_exception_cleans_partial(self):
        with patch('media.download_response', side_effect=RuntimeError('test exception')):
            with self.assertRaises(RuntimeError):
                self.store.stage(self.file)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        self.assertEqual(self.store.active, set())

    def test_closed_http_response_after_last_chunk(self):
        @contextmanager
        def closed_after_data(url):
            with fake_download(image_bytes('PNG')) as response:
                original = response.read1
                def read1(size):
                    data = original(size)
                    response.fp = None
                    return data
                response.read1 = read1
                yield response
        with patch('media.download_response', side_effect=closed_after_data):
            token = self.store.stage(self.file)
        handle, _, _ = self.store.open(token)
        handle.close()

    def test_tokens_cleanup_ttl_and_traversal(self):
        token = self.stage(image_bytes('PNG'))
        self.assertIsNone(self.store.open('../etc/passwd'))
        self.assertIsNone(self.store.open('b' * 64))
        self.now += 61
        self.assertIsNone(self.store.open(token))
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        token = self.stage(image_bytes('JPEG'))
        self.store.remove(token)
        self.assertIsNone(self.store.open(token))

    def test_store_capacity_and_shutdown(self):
        for _ in range(3):
            self.stage(image_bytes('PNG'))
        with self.assertRaises(MediaError):
            self.stage(image_bytes('PNG'))
        self.store.close()
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_private_dns_redirect_origin_policy(self):
        for url in ('http://files.example/a', 'https://u:p@files.example/a', 'https://files.example:8443/a'):
            with self.assertRaises(MediaError):
                public_target(url)
        with patch('media.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(MediaError):
                public_target('https://files.example/a')
        with patch('media.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))]):
            parsed, address = public_target('https://files.example/a?signature=sensitive')
        self.assertEqual(address, '8.8.8.8')
        self.assertEqual(parsed.hostname, 'files.example')


if __name__ == '__main__':
    unittest.main(verbosity=2)
