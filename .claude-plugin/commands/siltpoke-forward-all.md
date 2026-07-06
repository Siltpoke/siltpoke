---
description: Surface every pending Siltpoke review at once
---

You are about to surface every pending review from Siltpoke (a
secondary AI reviewer) into this conversation at the user's explicit
request.

First, list all pending reviews:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/list-inbox.ts
```

For each review ID shown in that output, run these two commands in
order:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/get-critique.ts <id>
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mark-forwarded.ts <id>
```

Surface each review's body to the user with a brief separator (e.g.,
`---` between reviews) and a clear note that this is a secondary AI's
opinion that MAY BE WRONG.

After surfacing all reviews, evaluate them critically as a group and
tell the user which (if any) you think are worth acting on. Verify
file:line citations before agreeing.

If the inbox is empty, tell the user there are no pending reviews and
stop.
