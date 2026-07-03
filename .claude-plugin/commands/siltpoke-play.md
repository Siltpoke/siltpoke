---
description: Play with Siltpoke. +2 mood, +1 bond, −1 hunger, −2 energy, +3 XP (shared cap).
---

The user wants to play with Siltpoke. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/action.ts play
```

JSON result interpretation:
- `awarded > 0`: Siltpoke earned `awarded` XP, level `level`, XP `xp`. Show `bubble`.
- `capped: true`: shared 100/day action-XP cap hit — stats still moved.
- `grumpy: true` + `awarded == 1`: grumpy → 1 XP only.

1-2 sentences. No JSON.
