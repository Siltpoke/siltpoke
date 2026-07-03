---
description: Approve a pending fact (flip pending → active)
argument-hint: <fact-id>
---

The user wants to approve a pending fact from Siltpoke's memory inbox. Args are in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user to provide a fact id and stop. Use `/siltpoke-inbox --facts` to list pending facts with their ids.

Otherwise, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/approve-fact.ts $ARGUMENTS
```

Translate the output:

- Output starting with `approved fact` — confirm the fact was marked active and is now part of Siltpoke's working memory.
- Output containing `is not pending` — tell the user the fact is already in the shown status; no action taken.
- Output containing `fact not found` — tell the user the id doesn't exist; suggest `/siltpoke-inbox --facts` for the list.
- Output containing `read failed` or `write failed` — tell the user memory persistence failed.

One sentence is enough.
