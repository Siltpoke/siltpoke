---
description: Submit free-text feedback on a Siltpoke review. Writes to preference log; will feed Reflexion rule generation in future phases.
argument-hint: <critique-id> <text>
---

The user wants to record free-text feedback on a Siltpoke review. Args are in `$ARGUMENTS`.

If `$ARGUMENTS` is empty or contains only a review id with no text, tell the user the usage and stop.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/siltpoke-feedback.ts $ARGUMENTS
```

Translate the JSON result:

- `ok: true, critique_id: "..."`: confirm feedback was recorded for that review id, mention it is saved to the preference log.
- `error: "usage: ..."`: tell the user they must provide both a review id and some feedback text. Example: `/siltpoke-feedback c-abc "this is wrong because we want explicit nulls"`.
- Any other error: report it as-is.

One or two sentences is enough.

Examples:
  /siltpoke-feedback c-abc "this is wrong because we want explicit nulls"
  /siltpoke-feedback c-def "good catch, missed the API path traversal"
