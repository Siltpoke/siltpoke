---
description: Remember a fact, goal, or constraint for the Siltpoke pet
argument-hint: [--type fact|goal|constraint] "claim text"
---

The user wants to store a memory claim in Siltpoke's long-term memory. Args are in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, tell the user the usage format and stop:
- `siltpoke remember "user prefers terse explanations"`
- `siltpoke remember --type goal "ship the feature by Friday"`
- `siltpoke remember --type constraint "never suggest React for backend work"`

Otherwise, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/remember.ts $ARGUMENTS
```

Translate the output:

- Output starting with `remembered:` — confirm the claim was saved with its type and id (for fact/goal) or just type (for constraint).
- Output containing `type inference failed` — tell the user Siltpoke could not infer the type automatically; suggest adding `--type fact`, `--type goal`, or `--type constraint` explicitly.
- Output containing `read failed` or `write failed` — tell the user memory persistence failed; they may want to check `~/.siltpoke/` permissions.
- Output containing `unknown flag` or `missing claim` or `--type must be` — repeat the error and remind the user of the correct usage.

One or two sentences is enough.
