---
description: Ask Siltpoke to review your work on the next message. Bypasses budget + quiet hours for one Brain call.
---

The user wants Siltpoke to explicitly review their recent work on the
next message — even if budget is exhausted or quiet hours are active.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/review.ts
```

The CLI writes a sentinel file (same mechanism as /siltpoke-wake). The
next Stop hook consumes it and bypasses budget + quiet-hour gates for
that one call. After that, normal enforcement resumes.

Tell the user one sentence: "Siltpoke will review on your next message,
even past budget or quiet hours."
