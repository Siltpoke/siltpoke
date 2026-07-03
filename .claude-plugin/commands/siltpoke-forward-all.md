---
description: Surface every pending Siltpoke critique at once
---

You are about to surface every pending critique from Siltpoke (a
secondary AI reviewer) into this conversation at the user's explicit
request.

First, list all pending critiques:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/list-inbox.ts
```

For each critique ID shown in that output, run these two commands in
order:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/get-critique.ts <id>
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mark-forwarded.ts <id>
```

Surface each critique's body to the user with a brief separator (e.g.,
`---` between critiques) and a clear note that this is a secondary AI's
opinion that MAY BE WRONG.

After surfacing all critiques, evaluate them critically as a group and
tell the user which (if any) you think are worth acting on. Verify
file:line citations before agreeing.

If the inbox is empty, tell the user there are no pending critiques and
stop.
