Follow AGENTS.md, README.md and SECURITY.md. This project uses Baileys on Node
24.19.0+ and a separate Python MCP adapter. Never use real account/session data
or real sends for automated tests. Preserve authorization boundaries, media target
checks, and sent/queued/unknown semantics. Normal CI has no publication privileges.
