# HTTP API and delivery behaviour

The generated OpenAPI document is `/api-docs.json`; the interactive UI is
`/api-docs`. Static documentation, `/session/link` assets and GET/HEAD `/health`
are public. Other routes require a bearer header. Never put tokens in query
parameters. Use the token-aware `scripts/status.js` or Swagger Authorize for
manual checks instead of placing a literal secret in a shell argument.

## Access matrix

| Role | Routes |
| --- | --- |
| API or admin | `/status`, `/connection-monitor`, `/monitor/status`, `/keepalive/status`, `/groups`, group info, `/channels` metadata |
| API or admin | POST `/send-message`, `/send-message-upload`, `/send-ephemeral-message`, `/channels/send-message`; GET `/test-message` requires explicit `to` and sends a real message |
| Admin only | `/qr-code`, `/admin/pairing/*`, session reset/logout/clean-auth, `/dead-letter-queue` and retry, group refresh/ephemeral settings, keep-alive mutations |

Channel routes additionally restrict socket peers using the private MCP service
DNS identity, with local GET diagnostics allowed. Admin authorization does not
remove that peer restriction. Unknown or malformed authorization is rejected
before parsing request bodies or buffering uploads. Missing server auth
configuration fails closed. Admin can perform regular API operations; an API
bearer cannot perform admin operations.

## Ordinary sends

POST `/send-message` accepts `to`, `message` and optionally either `imageUrl` or
`attachmentUrl`. Additional document fields include `attachmentFileName` and
`attachmentMimeType`. Individual destinations use international digits; groups
use their full `@g.us` JID. Synthetic examples such as `390000000000` and
`120363000000000000@g.us` are placeholders and must not be treated as contacts.
Newsletter `@newsletter` IDs use `/channels/send-message`, not the individual
recipient queue. The supported ephemeral expirations are 86400, 604800 and
7776000 seconds. Group-wide ephemeral changes require admin privileges.

Multipart POST `/send-message-upload` accepts one `attachment` file, at most
10 MiB, with bounded fields and parts. JSON bodies are bounded to 128 KiB.
Only configured external HTTPS media hosts are fetched. The downloader validates
all resolved addresses and pins the connection address; redirects, userinfo,
private/reserved targets and unapproved hosts fail before submission. The only
configured internal exception is a staged `/media/<capability>` URL on the exact
MCP service origin. Security-policy failures never trigger a text fallback.

## Outcomes and retries

| Response | Meaning |
| --- | --- |
| 200, `delivery_status=sent` where supplied | Submission returned successfully; actual receipt still requires functional verification |
| 202, `queued=true` | A durable v2 record was accepted; this is not delivery |
| 424 | Required media acquisition failed before submission |
| 502, `delivery_status=unknown` | Submission outcome is ambiguous; do not automatically repeat it |
| 401 / 403 | Missing/wrong/insufficient bearer, denied origin or denied channel peer |
| 429 | Request rate limit; observe `Retry-After` |
| 503 | Auth not configured, request/send slots busy or queue capacity exhausted |

Media policy is `required` by default. `optional` can fall back to text on ordinary
acquisition failure if text exists. `deferred` can persist a temporary acquisition
failure for later bounded processing. A denied target or invalid URL is not a
retryable policy exception. Failed SDK submissions are not automatically retried
when the actual outcome is uncertain. There is no exactly-once guarantee.

The v2 outbox is stored under `data/outbox-v2`, uses bounded attempts, age, capacity
and concurrency, and pauses when disconnected. `sending` records found after a
restart become `unknown`. The legacy `data/dead-letter-queue` is neither imported
nor replayed by the v2 worker or the retry endpoint. Queue read/retry is admin-only.
An explicit retry processes eligible due v2 records; it does not override unknown
outcomes or force a legacy replay.

## Sessions and limits

The public management page contains no QR/token material initially. It fetches
QR/pairing details only after an admin token is entered in memory. Retained
credentials are not automatically discarded to recover a disconnected session.
Use administrative reconnect diagnostics before considering destructive session
operations. Reset, logout and clean-auth are real account/session changes.

The process-wide request limiter defaults to 120 requests/minute per socket
peer, ignores forwarded addresses, caps tracked peers, and bounds active requests.
It is suitable for a small private gateway rather than distributed rate limiting.
MCP also limits tool invocation concurrency and temporary media capacity. Proxy
media timeouts, byte limits and outbox bounds can be configured using the
`MEDIA_*` and `OUTBOX_*` variables in source; review memory/storage before raising
limits. Keep the proxy private even when authenticated.
