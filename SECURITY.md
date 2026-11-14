# Security policy

Security fixes target the current 3.x line. This is a self-hosted project with no
guaranteed response time, uptime or backwards-compatible emergency fix policy.

Report a vulnerability privately using the repository's
[Report a vulnerability form](https://github.com/davide-vito-grammatica/whatsapp-mcp-gateway/security/advisories/new).
Include the affected version, a sanitized reproduction, expected/observed behaviour
and impact. Use synthetic data. Never include real tokens, pairing codes, QR images,
session files, recipients or message contents in public issues or reports.

The intended deployment keeps the proxy private and uses separate API/admin/MCP
bearers. Compromise of the host, Docker administration or session volume is outside
the bearer boundary. Media fetching must retain target/DNS/connection restrictions;
only the configured internal staged-media callback is a private-network exception.
A timeout or unknown send outcome must not trigger blind resubmission.

Rotate/revoke exposed credentials through their actual provider; removing a value
from Git does not revoke it. If a leak is discovered, keep affected histories
private, coordinate source cleanup and preserve only redacted operational context.
Dependency and image scans are release checks, not a claim that every possible
vulnerability is absent. Third-party components retain their own support policies.
