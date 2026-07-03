---
description: Manually run the entity-tagging janitor over memory.json (backfills entities on untagged active facts).
argument-hint:
---

The user wants to (re)tag entities on facts in Siltpoke's memory store
right now, instead of waiting for the next consolidate pass to pick up
untagged facts.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/tag-entities.ts
```

What happens:

1. Reads `memory.json`, finds every `active` fact with no `entities`
   (legacy facts predating the entity model + facts whose extraction
   never threaded entities through).
2. If none are found, prints `nothing to tag` and exits — no Brain call,
   no cost.
3. Otherwise makes one batched Haiku call to tag all untagged facts at
   once, writes the result back, and prints `tagged N facts`.

Show the CLI output verbatim:
- `tagged N facts` — the janitor ran and backfilled entities on N facts;
  the result was written back.
- `nothing to tag` — covers two cases: (a) every active fact already had
  entities, so the janitor never made a Brain call (no spend, nothing
  written); OR (b) it did call but the reply was malformed/failed and it
  degraded to tagging nothing (the Brain call's tokens were still
  ledgered, but nothing is written back).
- `no memory store found` — `memory.json` doesn't exist yet at
  `~/.siltpoke/`; nothing to tag until facts exist.

This is a manual trigger only — the same janitor (`tagUntaggedEntities`)
already runs automatically as part of consolidate.
