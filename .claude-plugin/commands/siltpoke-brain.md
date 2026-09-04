---
description: Show or set which CLI + model reviews your code. No-arg shows the current brain; `set review <family> [model]` changes it.
---

The user wants to see — or change — which brain reviews their code. This is the
baseline, no-dashboard-needed twin of the dashboard settings screen; both write
the SAME `brain.roles.review` block in `~/.siltpoke/config.json`.

Three shapes only:

- **No argument** (or the word `show`) → print the current brain: the builder
  that authored the code, each role's resolved `family · model`, and any
  per-builder review overrides.
- **`set review <family> [model]`** → the GLOBAL review pin: point the review
  brain at a CLI family for every builder, optionally pinning a model.
- **`set-builder <builder> <reviewer> [model]`** → a PER-BUILDER override: "when
  code built by `<builder>` is reviewed, use `<reviewer>`". Lets each concurrent
  window (claude / codex / agy …) review with its own rule. A `[model]` is only
  accepted when `<reviewer>` is `claude` (the other families serve an auth-fixed
  model — the CLI rejects a model on them).

Legal `<family>` / `<builder>` / `<reviewer>` values — this is the COMPLETE list:

- `claude` · `codex` · `agy` · `qoder` · `codebuddy`

Run the matching form:

```bash
# show (no-arg or the literal word `show`)
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" brain

# set the GLOBAL review brain
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" brain set review "<family>" "<model>"

# set a PER-BUILDER override (model only when reviewer is claude)
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" brain set-builder "<builder>" "<reviewer>" "<model>"
```

Substitute `<family>` ONLY with one of the five legal values above, and
`<model>` ONLY with a model name the user actually typed. If what they typed is
not one of the five families, do NOT put it in the command — tell them the
legal list and ask again. Drop the trailing `"<model>"` argument entirely when
the user did not name a model (the CLI then uses that family's account default).
Their raw text must never reach the shell unmatched; the five family values
contain nothing a shell can act on.

The CLI validates the family/role again and refuses to write on an unknown
token, so a bad value is safe — it just prints the legal list and exits
non-zero. Report the CLI output verbatim.

Then mention:

- The change takes effect on the NEXT review — nothing re-runs past reviews.
- The dashboard settings screen writes the same config, so either surface works.
- `/siltpoke-doctor` shows which brain is currently resolved for review.
