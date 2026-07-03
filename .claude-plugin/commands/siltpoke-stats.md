---
description: Show Siltpoke's daily spend, budget state, and trigger mode
---

The user wants a snapshot of today's Siltpoke spending and current
budget/trigger state.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/stats.ts
```

The CLI prints a JSON object. Translate it into a short human-readable
summary covering:

- **Day & calls**: `day`, `brain_calls`, `reflections`
- **Tokens & cost**: `total_input_tokens + total_output_tokens + total_cache_tokens`, `total_cost_usd`
- **Budget**: `used_pct` of `daily_token_limit`, `budget_stage` (ok/soft/hard), `remaining_tokens`
- **Mode**: `trigger_mode`, whether `quiet_active`

If `budget_stage` is `soft`, mention that Siltpoke is now in on-demand
mode until reset and `/siltpoke-wake` can grant a one-shot bypass. If
`hard`, mention that Brain is fully muted until reset (`/siltpoke-wake`
still works for one call).

Keep the summary to 3-5 lines. Don't dump the JSON.
