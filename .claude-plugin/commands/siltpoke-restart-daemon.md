---
description: Restart the Siltpoke dashboard daemon (stops the running server and starts a fresh one).
---

The user wants to restart the Siltpoke dashboard daemon — usually because
it seems stuck, or after an update. Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" restart-daemon
```

The CLI SIGTERMs whatever currently holds the dashboard pidfile under
`~/.siltpoke/`, waits for it to stop answering, then spawns a fresh
daemon on the same port (127.0.0.1:9876). If nothing was running, it
just starts one.

Translate for the user:

- Exit 0 (output ends with `Siltpoke: http://127.0.0.1:9876/`): tell them
  the daemon was restarted and the dashboard is live at that URL.
- Exit 1 (`siltpoked failed to start within 3s`): the fresh server did not
  come up. Tell them, and suggest `/siltpoke-doctor` to find out which
  piece is missing.

Keep the response to one sentence. Don't show the raw output.
