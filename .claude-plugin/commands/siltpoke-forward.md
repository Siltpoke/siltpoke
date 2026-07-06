---
description: Surface a specific Siltpoke review by ID into the conversation
argument-hint: <critique-id>
---

You are surfacing a review from Siltpoke (a secondary AI reviewer) into
this conversation at the user's explicit request. The review ID is in
`$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user to provide a review ID
(e.g., `/siltpoke-forward c-a7b3`) and stop.

Run this bash command to get the specified review markdown:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/get-critique.ts $ARGUMENTS
```

Show the full output to the user. Then mark the review as forwarded:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mark-forwarded.ts $ARGUMENTS
```

Critically evaluate the review. Siltpoke's opinion MAY BE WRONG —
verify against the actual code before acting on any suggestion. If the
review cites file:line evidence, read those locations before agreeing
or disagreeing. Tell the user your assessment in your reply.
