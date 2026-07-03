---
description: Start Siltpoke's dashboard server in the background. Opens browser at http://127.0.0.1:9876.
---

The user wants to start the Siltpoke dashboard. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/report.ts
```

The CLI spawns a detached server, writes the PID to `~/.siltpoke/report.pid`,
and exits immediately. Output includes the URL and PID.

Translate for the user:

- If output contains "started in background": tell the user the dashboard is
  live at `http://127.0.0.1:9876` and they can stop it with `/siltpoke-report-stop`.
- If output contains "already running": tell the user it's already running,
  the URL is `http://127.0.0.1:9876`, and they need `/siltpoke-report-stop`
  first if they want to restart.

Keep the response to 1-2 sentences. Don't show the raw output.
