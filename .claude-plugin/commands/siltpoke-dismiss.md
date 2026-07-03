---
description: Dismiss a Siltpoke critique and let Siltpoke learn from why it was wrong
argument-hint: <critique-id> [reason]
---

You are dismissing a Siltpoke critique at the user's explicit request.
Arguments are in `$ARGUMENTS`. The first token is the critique id
(e.g. `c-a7b3` or `latest`); everything after it is the dismiss reason
explaining why the critique was wrong.

If `$ARGUMENTS` is empty, tell the user the usage is
`/siltpoke-dismiss <critique-id> "why it was wrong"` and stop. A reason
is optional but strongly encouraged — without one, Siltpoke can flip
the critique status but cannot learn anything from the dismissal.

Run this bash command:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/dismiss.ts $ARGUMENTS
```

The CLI prints a single JSON object describing what happened. Use it to
tell the user:

- If `status_set` is `"not_found"`: the critique id was wrong. Suggest
  `/siltpoke-inbox` to list pending critiques.
- If `status_set` is `"dismissed"` or `"already_dismissed"`: confirm the
  status flip, then look at `reflection`:
  - `rule_appended: true` — congratulate the user. Siltpoke just learned
    something. Show `rule_text` so the user knows exactly what rule will
    apply to future Brain calls.
  - `skip_reason: "no_reason"` — no learning occurred. If the user wants
    Siltpoke to actually learn from this dismissal, suggest re-running
    with a reason.
  - `skip_reason: "low_confidence"` — Siltpoke ran a reflection but was
    not confident enough to commit a rule. Tell the user briefly.
  - `skip_reason: "duplicate"` — the rule already exists. Mention which
    rule (`rule_id`) and that Siltpoke is already applying it.
  - `skip_reason: "error"` — the reflection Brain call failed. The
    dismissal still went through; only the learning step was skipped.

Keep the user-facing summary terse. The JSON output is for you to read,
not the user — translate it into one or two sentences plus the rule
text if a rule was appended.
