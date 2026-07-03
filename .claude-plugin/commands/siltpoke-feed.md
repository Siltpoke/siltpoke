---
description: Feed Siltpoke. +3 hunger, +1 mood, +5 XP (shared 100/day action-XP cap).
---

The user wants to feed Siltpoke. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/action.ts feed
```

The CLI prints a JSON result. Translate it for the user:

- If `awarded > 0`: tell the user Siltpoke earned `awarded` XP, level is
  `level`, XP is `xp`. Show `bubble` verbatim.
- If `capped: true`: today's shared action-XP cap (100/day across feed/play/
  clean/pet) is hit — hunger/mood still moved but no XP. Resets at midnight.
- If `grumpy: true` and `awarded == 1`: XP collapsed to 1 because Siltpoke is
  grumpy from teases.

Keep response to 1-2 sentences. Don't show the JSON.
