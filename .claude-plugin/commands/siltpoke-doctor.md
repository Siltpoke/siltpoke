---
description: Install-health diagnostic — a ✓/✗ checklist of every piece Siltpoke needs (settings, hooks, schema, config, brain) plus warn-only daemon rows.
---

The user wants to diagnose their Siltpoke install. Common triggers: no
review ever appears, the pet's face is missing from the statusline, the
schema migration looks half-applied, "is this thing even alive?".

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" doctor
```

The CLI prints a ✓/⚠/◦/✗ checklist (install-health checks, plus warn-only
daemon rows that never fail the run) and exits 0 (all healthy) or 1 (any
check failed). Show the output verbatim — do NOT translate it. Each
failing row already carries the path and the actionable detail.

For JSON (piping into another tool), add `--json`. For a one-line
summary, add `--quiet`.

If all checks pass: say so concisely. Don't pad with prose — the card
already says "Install healthy."

If a check fails: read the detail line back to the user verbatim, then
help them act on it. Common fixes:

- `settings.json` missing / Stop hook not wired / statusline missing →
  re-run `/siltpoke-setup` (idempotent — it will not clobber the pet).
- `config.json` missing or missing fields → `/siltpoke-setup` again; that
  is what creates the pet.
- `global.json` schema mismatch → possibly a stalled migration. Report the
  detail verbatim rather than guessing at a fix.
- Brain check failing (`claude` not on PATH) → reviews run through the
  user's `claude` CLI; if that binary is not installed or not on PATH,
  nothing can review. Tell them to install it and re-run doctor.
- Symlink rows → these are only meaningful for a from-source install. A
  plugin install has no symlinks; that row is not something the user
  broke.
