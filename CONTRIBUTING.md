# Contributing

Use Node 24.19.0+ and Python 3.13 for the canonical test environment. Start from
`npm ci` and a Python virtual environment with `mcp/requirements.txt`. Run:

```sh
npm test
npm audit --omit=dev --audit-level=high
python mcp/test_mcp.py
pip check
```

The CI also audits the pinned Python requirements, scans Git history for secrets,
builds both images, exercises them without external networking, verifies synthetic
credential preservation, and scans both images before any manual publication.
Three known moderate findings in the Swagger glob/minimatch chain are confined to
fixed local file-pattern processing at startup; HTTP callers cannot supply patterns.
Reassess that conclusion if the spec-loading behaviour changes.

Tests must use mocked WhatsApp sockets and synthetic credentials/recipients. Do
not send real messages, request live pairing codes, logout/reset accounts or replay
queues during automated checks. Preserve sent/queued/unknown semantics and test
failure paths when changing delivery behaviour. Never attach runtime sessions,
credential files, queue records, private logs or a knowledge base to a PR/issue.

Submit a focused pull request with the problem, resulting behaviour and checks
actually performed. The author keeps copyright in their contribution; contributions
to original project code use the project ISC license. Retain upstream notices when
including third-party material and review its actual terms before redistribution.
Report security problems through [SECURITY.md](SECURITY.md), not a public issue.
