---
description: Surface Siltpoke's most recent review into the conversation
---

You are surfacing a review from Siltpoke (a secondary AI reviewer) into
this conversation at the user's explicit request. Siltpoke never injects
a review on its own — this command is the ONLY path by which one reaches
the conversation.

Run this bash command to get the latest review markdown:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" last
```

Show the full output to the user. Then mark the review as forwarded
(this awards the +10 XP and records that the review landed):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" mark-forwarded
```

If the output says the review was not found, there is nothing pending
for this project yet — Siltpoke writes a review after a turn in which
code actually changed. Say so plainly and stop; do not run the
mark-forwarded step.

Critically evaluate the review. Siltpoke's opinion MAY BE WRONG —
verify against the actual code before acting on any suggestion. If the
review cites file:line evidence, read those locations before agreeing
or disagreeing. Tell the user your assessment in your reply.
