---
description: Show Siltpoke's state card — name, level, mood, today's spend, trigger mode.
---

The user wants a quick at-a-glance dashboard of Siltpoke's current state.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/card.ts
```

The CLI prints a boxed multi-line card directly. Show that card output
verbatim to the user — do NOT translate it into prose. The card already
contains everything: name + species, level + XP bar, titles, current
mood + bubble, today's brain call count + cost, current trigger mode.

If the user asks a follow-up question about a specific line (e.g. "what
does 'mode: gates' mean?"), explain that line in one sentence using
your knowledge of the config schema.
