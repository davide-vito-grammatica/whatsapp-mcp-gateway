# MCP adapter

The stateless HTTP endpoint is `/mcp` on port 8766 inside the Compose network.
Use `MCP_AUTH_TOKEN` as a bearer for initialize/list/tool requests. The backend
`WHATSAPP_API_TOKEN` is configured separately and is never accepted as an external
transport token. MCP does not own the WhatsApp session, mount auth data, normalize
account state, or automatically retry sends after timeouts.

Read-only tools: `get_whatsapp_status`, `list_whatsapp_channels`,
`search_whatsapp_channels`, `get_whatsapp_channel`.

Real-send tools: `send_whatsapp_message`, `send_whatsapp_image`,
`send_whatsapp_channel_message`, `send_whatsapp_channel_image`. Send annotations
are non-idempotent. Invoke only after an explicit user request and reconcile any
ambiguous outcome before repeating it. Listing channels can be partial; metadata
reports inventory completeness and publishing roles without assuming membership
confers administrator rights.

Image tools accept a structured file object with `download_url` and `file_id`,
optionally MIME/name metadata. File URLs are validated and downloaded into bounded
private staging, decoded as supported image formats and exposed through an opaque,
expiring internal capability URL. A raw `file_id` alone is not a downloadable file.
JPEG, PNG, GIF and WebP are supported subject to byte/pixel/type checks. Staged
media is cleaned after its TTL and at shutdown. It is not a persistent attachment
archive. Legacy external image URLs require explicit trusted host configuration.

Configure `MCP_ALLOWED_HOSTS` for the hostname used by your trusted ingress and
`MCP_ALLOWED_ORIGINS` for any explicitly trusted browser origin. Leave the proxy
port private; do not route the administrative HTTP API through the MCP endpoint.
The unauthenticated MCP `/health` endpoint returns minimal backend availability.
Internal media GET capabilities are intentionally bearer-less, bounded and opaque;
other MCP requests require the transport bearer.

## Optional dedicated tunnel

The distributed Compose has an opt-in `tunnel` profile. It uses the pinned tunnel
client image and a dedicated runtime credential. Provision a tunnel for this
service, copy `docker/.env.tunnel.example` to `docker/.env.tunnel` outside Git,
protect it with mode 0600, and populate its ID/key privately. Do not reuse an
unrelated service's tunnel identity. The client forwards only to the MCP service.

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile tunnel config --quiet
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile tunnel up -d --no-deps --wait whatsapp-mcp-tunnel
```

Register the resulting HTTPS MCP URL with the client you use, supplying the
external bearer privately. Tunnel provisioning and client-side feature availability
are external prerequisites, not fabricated endpoints supplied by this repository.
A custom trusted ingress can be used instead of the optional tunnel.

## Safe runtime smoke check

With both services running, this command initializes MCP, lists tool schemas,
checks annotations/authentication and calls status only:

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml exec -T whatsapp-mcp python /app/smoke_test.py
```

It does not send, pair, reset or replay messages. A `connected/good` status is a
technical read check; verify actual message receipt separately with an explicitly
authorized recipient when performing your own functional test.
