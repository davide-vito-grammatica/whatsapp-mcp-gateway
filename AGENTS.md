# Repository instructions

This is a personal self-hosted WhatsApp HTTP/MCP gateway. Read README.md and
SECURITY.md before changes. Source is ISC; preserve third-party terms/notices.

- Node 24.19.0+; canonical Python test runtime 3.13. Use npm ci and the pinned MCP requirements.
- Proxy tests: npm test. MCP tests: python mcp/test_mcp.py. Runtime audit: npm audit --omit=dev --audit-level=high.
- Build proxy with docker/Dockerfile and MCP with mcp/Dockerfile. Use the isolated CI smoke script for runtime checks.
- All automated checks use synthetic state and mocks. Never send, pair, reset,
  logout, replay a queue or use production credentials merely to test code.
- Distinguish external MCP, backend API and administrative bearers. Authenticate
  before parsing input; preserve media target restrictions and fail-closed behaviour.
- Keep actual runtime data, backups, secrets and local knowledge bases outside Git.
- Normal pushes/PRs validate without publishing. Manual release publication must
  use the already tested/scanned images, exact digest records and the current repository namespace.
- Do not build or deploy on a user's runtime host without task authorization.
  Deployment must include a verified checkpoint and a reconciled rollback plan.
- Prefer small patches and existing tools; do not add frameworks merely to replace
  a stale documentation command. Report checks actually run and any open limitation.
