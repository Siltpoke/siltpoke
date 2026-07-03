---
description: Surface a specific Siltpoke critique by ID into the conversation
argument-hint: <critique-id>
---

You are surfacing a critique from Siltpoke (a secondary AI reviewer) into
this conversation at the user's explicit request. The critique ID is in
`$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user to provide a critique ID
(e.g., `/siltpoke-forward c-a7b3`) and stop.

Run this bash command to get the specified critique markdown:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/get-critique.ts $ARGUMENTS
```

Show the full output to the user. Then mark the critique as forwarded:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mark-forwarded.ts $ARGUMENTS
```

Critically evaluate the critique. Siltpoke's opinion MAY BE WRONG —
verify against the actual code before acting on any suggestion. If the
critique cites file:line evidence, read those locations before agreeing
or disagreeing. Tell the user your assessment in your reply.
