---
description: Surface Siltpoke's most recent review into the conversation
---

You are surfacing a review from Siltpoke (a secondary AI reviewer) into
this conversation at the user's explicit request.

Run this bash command to get the latest review markdown:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/get-critique.ts latest
```

Show the full output to the user. Then mark the review as forwarded:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mark-forwarded.ts latest
```

Critically evaluate the review. Siltpoke's opinion MAY BE WRONG —
verify against the actual code before acting on any suggestion. If the
review cites file:line evidence, read those locations before agreeing
or disagreeing. Tell the user your assessment in your reply.
