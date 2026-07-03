---
description: Show pending Siltpoke critiques waiting to be forwarded
---

List all critiques in Siltpoke's pending inbox. Do NOT mark anything as
forwarded — this is a read-only listing.

Run this bash command:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/list-inbox.ts
```

Show the full output to the user verbatim. If pending critiques exist,
suggest the user run `/siltpoke-forward <id>` to surface a specific one,
or `/siltpoke-forward-all` to surface every pending critique at once.
