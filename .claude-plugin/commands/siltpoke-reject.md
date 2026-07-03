---
description: Reject a pending fact (flip pending → retired)
argument-hint: <fact-id>
---

The user wants to reject a pending fact from Siltpoke's memory inbox. Args are in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user to provide a fact id and stop. Use `/siltpoke-inbox --facts` to list pending facts with their ids.

Otherwise, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/reject-fact.ts $ARGUMENTS
```

Translate the output:

- Output starting with `rejected fact` — confirm the fact was retired with reason `user_rejected` and will no longer appear in the active memory or inbox.
- Output containing `is not pending` — tell the user the fact is already in the shown status; no action taken.
- Output containing `fact not found` — tell the user the id doesn't exist; suggest `/siltpoke-inbox --facts` for the list.
- Output containing `read failed` or `write failed` — tell the user memory persistence failed.

One sentence is enough.
