---
description: Acknowledge a Siltpoke critique. Neutral status flip — no XP, no Reflexion.
argument-hint: <critique-id>
---

The user wants to acknowledge a critique without saying it was right
(forward) or wrong (dismiss). Args are in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user to provide a critique id and stop.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/ack.ts $ARGUMENTS
```

Translate the JSON result:

- `status_set: "acked"`: confirm the critique was marked seen, no XP
  changes, no learning event triggered.
- `status_set: "already_acked"`: tell the user it was already acked.
- `status_set: "not_found"`: tell the user the id doesn't exist; suggest
  `/siltpoke-inbox` for the list.

One sentence is enough.
