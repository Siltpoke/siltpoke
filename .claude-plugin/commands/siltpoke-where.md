---
description: Print the resolved Siltpoke project identity for the current working directory
---

Show how Siltpoke identifies the project for the current cwd:
- `project_id` — stable 16-hex sha256 used to key per-project memory
- `project_root` — the directory we treat as the project root
- `display_name` — friendly name (basename or marker-supplied)
- `source` — `marker` (`.siltpoke/marker.json` found), `git` (walked up to a `.git/`), or `fallback` (neither; ephemeral project)

Run this bash command:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/where.ts
```

Show the JSON output verbatim.
