---
description: Clear the Siltpoke mute marker so the critic fires again.
---

The user wants to end an active mute (or just confirm Siltpoke isn't
muted).

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/unmute.ts
```

The CLI deletes `~/.siltpoke/mute.json` (the mute marker that
`/siltpoke-mute` writes). Idempotent — running it on an already-unmuted
Siltpoke is a no-op (exit 0, output says "wasn't muted").

Tell the user verbatim from the CLI output:
- "Siltpoke unmuted. Critic will fire again on next Stop hook." — file
  was removed.
- "Siltpoke wasn't muted. No change." — no file to remove.

For JSON output (scripting): `bun ... unmute.ts --json`.

Related: `/siltpoke-mute <duration>` to re-mute.
