---
description: Chat with Siltpoke's AI via the daemon (single-turn, REPL, or search)
---

Send a message to Siltpoke's chat backend (`POST /api/chat` on the daemon at
:9876). The daemon persists messages as JSONL, indexes them via SQLite FTS5,
and streams the assistant response back via SSE.

Run this bash command with the user-provided arguments:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/chat.ts "$@"
```

Common usage:

- `siltpoke chat "hello"` — single-turn against a fresh session
- `siltpoke chat --session <sid> "follow up"` — resume a prior session
- `siltpoke chat --search "ripgrep"` — FTS5 search over all chat history
- `siltpoke chat` — REPL mode (Ctrl-D / `.quit` to exit)

Show the full output to the user verbatim.
