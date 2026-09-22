---
description: Wake Siltpoke — clear a stuck review breaker and force a review on the next turn.
---

The user wants Siltpoke to review again. Two situations lead here:

- Reviews went quiet and `/siltpoke-doctor` says `breaker open` — one or more
  Brain calls failed, so Siltpoke stopped calling it. A `permanent` breaker
  stays latched rather than expiring on a timer. `/siltpoke-doctor` clears the
  missing-binary flavour by itself once `claude` is back on PATH; the
  auth flavour (bad or expired credentials) it deliberately will not clear,
  because a re-verify cannot prove auth was fixed — that one needs this command.
- The user wants a review of the next turn even though nothing new was
  committed.

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" wake
```

This clears the breaker immediately and writes `~/.siltpoke/wake.json`, a
one-shot 5-minute marker that makes the next Stop hook review regardless of the
breaker, quiet-hours, budget, review-unit and no-code-change gates.

The one gate it does NOT beat is mute: `/siltpoke-mute` is checked first, on
purpose, so an unused wake survives the mute window. The CLI says so when a
mute is active.

Clearing means "try now", not "declare healthy": the consecutive-failure count
is kept, so if the Brain fails again the breaker reopens at the escalated
window. Fix the cause first when there is one.

Tell the user verbatim from the CLI output:
- "Siltpoke woken. The <class> breaker … is cleared" — reviews were blocked and
  now are not. Add: if the underlying failure is still there (not logged in,
  expired token, `claude` not on PATH), the very next call reopens it — run
  `/siltpoke-doctor` to see the last failure.
- "Siltpoke woken. No breaker was open …" — nothing was blocked; the next turn
  just gets a review even with no new commit.
- Any line containing "Siltpoke is muted … mute beats wake" — pass it on. The
  wake is stored, but no review runs until `/siltpoke-unmute`.

Related: `/siltpoke-doctor` (why the Brain failed), `/siltpoke-last` (the most
recent review).
