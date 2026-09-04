---
description: Clear the Siltpoke mute marker so reviews fire again.
---

The user wants to end an active mute (or just confirm Siltpoke isn't
muted).

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" unmute
```

The CLI deletes `~/.siltpoke/mute.json` (the mute marker that
`/siltpoke-mute` writes). Idempotent — running it on an already-unmuted
Siltpoke is a no-op (exit 0, output says "wasn't muted").

Tell the user verbatim from the CLI output:
- "Siltpoke unmuted. Code Review will fire again on next Stop hook." — the
  marker was removed.
- "Siltpoke wasn't muted. No change." — there was no marker to remove.

Related: `/siltpoke-mute <duration>` to re-mute.
