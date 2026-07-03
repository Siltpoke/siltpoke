---
description: Pet Siltpoke. Grants +5 XP (shared 100/day action-XP cap with dashboard).
---

The user wants to pet Siltpoke. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/action.ts pet
```

The CLI prints a JSON result. Translate it for the user:

- If `awarded > 0`: tell the user Siltpoke earned `awarded` XP, level is
  `level`, XP is `xp`. Show `bubble` verbatim — that's what Siltpoke said.
- If `capped: true`: tell the user today's shared action-XP cap (100/day across
  feed/play/clean/pet) is hit — stats still moved but no XP this click. Resets
  at local midnight.
- If `grumpy: true` and `awarded == 1`: Siltpoke is grumpy from too many teases,
  so XP collapsed to 1.

Keep response to 1-2 sentences. Don't show the JSON.
