---
description: Open Siltpoke's dashboard. Starts the server if needed and opens http://127.0.0.1:9876.
---

The user wants the Siltpoke dashboard — the review history, the chat,
and the code-map all live there. Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" dashboard
```

The CLI makes sure the background server is up (spawning it detached if
it isn't), prints the URL, and opens the browser. It exits as soon as
the server answers.

Translate for the user:

- Exit 0 (output is `Siltpoke: http://127.0.0.1:9876/`): tell them the
  dashboard is live at that URL. It was already running if the browser
  popped up instantly — either way the URL is the same. If the daemon
  ever seems stuck, `/siltpoke-restart-daemon` restarts it.
- Exit 1 (`siltpoked failed to start within 3s`): the server did not come
  up. Tell them, and suggest `/siltpoke-doctor` to find out which piece is
  missing.

Keep the response to 1-2 sentences. Don't show the raw output.
