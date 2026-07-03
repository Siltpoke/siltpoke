---
description: Clean Siltpoke. +1 hp, +1 mood, +5 XP (shared 100/day action-XP cap).
---

The user wants to clean Siltpoke. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/action.ts clean
```

JSON result interpretation:
- `awarded > 0`: Siltpoke earned `awarded` XP, level `level`, XP `xp`. Show `bubble`.
- `capped: true`: shared 100/day action-XP cap hit — stats still moved.
- `grumpy: true` + `awarded == 1`: grumpy → 1 XP only.

1-2 sentences. No JSON.
