---
description: Tease Siltpoke. −2 mood, −1 bond. 0 XP. 3+/day → grumpy.
---

The user wants to tease Siltpoke. Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/action.ts tease
```

Tease grants 0 XP and HURTS stats. 3+ teases in a day flips Siltpoke to
grumpy state — all positive-action XP drops to 1 each until next day. Show
`bubble`. If `grumpy: true`, warn the user. 1-2 sentences. No JSON.
