---
description: Stop the background Siltpoke dashboard server.
---

The user wants to stop the Siltpoke dashboard. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/report-stop.ts
```

The CLI reads `~/.siltpoke/report.pid`, sends SIGTERM, removes the file.

Translate for the user:

- If output contains "Stopped": tell the user the dashboard server stopped.
- If output contains "stale pid file": tell the user the server wasn't
  actually running; cleaned up a leftover PID file.
- If output contains "not running": tell the user the dashboard wasn't running.

Keep the response to one sentence. Don't show the raw output.
