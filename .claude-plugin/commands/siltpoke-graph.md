---
description: Open the Siltpoke code-map dashboard in the browser. Auto-starts daemon at http://127.0.0.1:9876/repo-graph.
---

The user wants to open the Siltpoke code-map viz. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/graph.ts
```

The CLI ensures the daemon is up (lazy-spawn if needed) then opens the
default browser to `/repo-graph?repo=<proj_hash>` so the multi-repo picker
lands on the current cwd's project.

Translate for the user (1-2 sentences):

- If output contains `Siltpoke code map:` followed by a URL: tell the user
  the code-map page is open in their browser; mention the URL ends with
  the current repo's proj_hash so they're looking at this codebase.
- If output contains `failed to start`: tell the user the daemon couldn't
  start; suggest running `/siltpoke-doctor` to diagnose.

Don't show the raw output.
