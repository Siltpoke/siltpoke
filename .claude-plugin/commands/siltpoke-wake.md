---
description: Bypass Siltpoke's budget and quiet-hours gates for one Brain call
---

The user wants Siltpoke to run a Brain review on the next Stop event
even if the daily token budget is exhausted or quiet hours are active.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/wake.ts
```

The CLI writes a sentinel file at `~/.siltpoke/wake.json` with a
5-minute TTL. The next Stop hook consumes that file and short-circuits
the budget and quiet-hours gates for that one call. After that, normal
budget enforcement resumes.

Tell the user:
- Siltpoke will run one more Brain call regardless of budget or quiet
  hours.
- The bypass is one-shot — subsequent calls will hit the same gates
  again until they raise `dailyTokenLimit` or quiet hours end.
- If they want to disable budget entirely, set
  `"budget": { "dailyTokenLimit": 0 }` in `~/.siltpoke/config.json`.
