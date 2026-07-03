---
description: Run /siltpoke-doctor — install-health diagnostic. 7 ✓/✗ checks (settings, hooks, inner.txt, wake, schema, symlinks, config).
---

The user wants to diagnose their Siltpoke install. Common triggers: Stop
hook not firing, slash commands missing after a repo move, schema
migration looks half-applied, "is this thing even alive?".

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/doctor.ts
```

The CLI prints a 7-row ✓/✗ checklist and exits 0 (all healthy) or 1
(any check failed). Show the output verbatim — do NOT translate. Each
failing row already includes the path and the actionable detail (e.g.
"Run `bun src/cli/install.ts` to re-register").

If the user wants JSON output (e.g. piping into another tool), run
`bun .../doctor.ts --json`. If they only want a one-line summary, run
`... --quiet`.

If all checks pass: say so concisely. Don't pad with prose — the card
already says "Install healthy."

If a check fails: read the detail line back to the user verbatim, then
help them act on it. Common fixes:

- `settings.json` missing → `bun src/cli/install.ts`
- Stop hook not paired → `bun src/cli/install.ts` (idempotent)
- `global.json` schema mismatch → potentially a stalled migration; check
  the schema migration notes
- Symlinks broken → the repo likely moved since install. Re-run
  `bun src/cli/install.ts` from the new location.
- `config.json` missing fields → `bun src/cli/first-run.ts` (re-runs
  the personality wizard).
