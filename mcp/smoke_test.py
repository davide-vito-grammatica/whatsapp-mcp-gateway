"""Authenticated initialize/list/status only. NEVER invokes an actual send."""
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler


def run():
    endpoint = 'http://127.0.0.1:' + os.environ.get('MCP_PORT', '8766') + '/mcp'
    opener = build_opener(ProxyHandler({}))
    headers = {'Authorization': 'Bearer ' + os.environ['MCP_AUTH_TOKEN'],
               'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'}

    def request(method, params=None, request_id=1):
        payload = {'jsonrpc': '2.0', 'method': method}
        if request_id is not None:
            payload['id'] = request_id
        if params is not None:
            payload['params'] = params
        with opener.open(Request(endpoint, json.dumps(payload).encode(), headers), timeout=20) as response:
            content = response.read()
        return json.loads(content) if content else None

    initialized = request('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                        'clientInfo': {'name': 'whatsapp-safe-smoke', 'version': '1.0'}})
    assert 'result' in initialized, initialized
    headers['MCP-Protocol-Version'] = initialized['result']['protocolVersion']
    request('notifications/initialized', request_id=None)
    listing = request('tools/list', request_id=2)['result']['tools']
    assert {tool['name'] for tool in listing} == {'send_whatsapp_message', 'get_whatsapp_status', 'send_whatsapp_image', 'list_whatsapp_channels', 'search_whatsapp_channels', 'get_whatsapp_channel', 'send_whatsapp_channel_message', 'send_whatsapp_channel_image'}
    for tool in listing:
        expected_read = tool['name'] in {'get_whatsapp_status', 'list_whatsapp_channels', 'search_whatsapp_channels', 'get_whatsapp_channel'}
        assert tool['annotations']['readOnlyHint'] == expected_read
        if not expected_read:
            assert tool['annotations']['idempotentHint'] is False
    image_tool = next(tool for tool in listing if tool['name'] == 'send_whatsapp_image')
    assert image_tool['_meta']['openai/fileParams'] == ['file']
    file_schema = image_tool['inputSchema']['properties']['file']
    assert file_schema['type'] == 'object'
    assert 'default' not in file_schema
    assert 'null' not in json.dumps(file_schema)
    assert 'file' not in image_tool['inputSchema']['required']
    assert '$ref' not in file_schema
    assert set(file_schema['required']) == {'download_url', 'file_id'}
    assert {'download_url', 'file_id', 'mime_type', 'file_name'} <= file_schema['properties'].keys()
    status = request('tools/call', {'name': 'get_whatsapp_status', 'arguments': {}}, 3)['result']
    data = status.get('structuredContent') or json.loads(status['content'][0]['text'])
    assert data['success'] is True, data
    assert data['connection_status'] in {'connected', 'connecting', 'disconnected'}
    assert 'qr' not in json.dumps(data).lower()
    try:
        opener.open(Request(endpoint, json.dumps({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list'}).encode(),
                            {'Accept': headers['Accept'], 'Content-Type': 'application/json'}), timeout=5)
        raise AssertionError('Unauthenticated MCP request accepted')
    except HTTPError as error:
        assert error.code == 401
    print(json.dumps({'initialize': 'passed', 'tools': [t['name'] for t in listing],
                      'annotations': 'passed', 'file_parameter': 'passed', 'file_schema': file_schema, 'authentication': 'passed', 'status': data}, ensure_ascii=False))


if __name__ == '__main__':
    run()
