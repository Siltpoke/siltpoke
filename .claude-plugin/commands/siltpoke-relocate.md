---
description: Update the current Siltpoke project's recorded root path (preserves project_id)
---

Re-point a Siltpoke project at a new path on disk. `project_id` stays stable; only `project_root` (and any opt-in `.siltpoke/marker.json`) is updated.

Use this when you've moved or renamed a project directory and want Siltpoke to keep tracking the same project memory.

Usage:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/relocate.ts <new-absolute-path>
```

Show the output verbatim. Exit codes: 0 success, 1 read/write error, 3 missing argument.
