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

If the output says **`no reviews yet`**, there is nothing pending for this
project — Siltpoke writes a review after a turn in which code actually
changed, so a fresh install has none. Say so plainly and stop; do NOT run
the mark-forwarded step. This is a normal state, not a failure: do not
suggest `/siltpoke-doctor` or imply the install is broken.

If instead it says **`no review with id '<x>'`**, the project DOES have
reviews and that particular id is not one of them. Re-run `last` with no
argument for the most recent one.

If it says **`the `latest` pointer is missing`**, the reviews are still on
disk and only the shortcut to the newest one is gone. Do NOT re-run `last`
with no argument — that produces the same message again. Tell the user their
reviews are intact under `.siltpoke/critiques/archive/`, and that the next
review will rewrite the pointer.

Critically evaluate the review. Siltpoke's opinion MAY BE WRONG —
verify against the actual code before acting on any suggestion. If the
review cites file:line evidence, read those locations before agreeing
or disagreeing. Tell the user your assessment in your reply.
