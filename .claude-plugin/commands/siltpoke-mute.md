---
description: Silence Siltpoke for a duration. Mute beats wake — Code Review never fires while active.
---

The user wants Siltpoke quiet for pair-programming, a demo, or a focus
block. They pass a duration as the argument.

Accepted durations:
- `15m` / `30m` — minutes
- `1h` / `4h` — hours
- `1d` / `2d` — days
- `indefinite` — silent until `/siltpoke-unmute`

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/mute.ts <duration>
```

(Substitute `<duration>` with whatever the user said. If they didn't
pass anything, ask them — empty arg exits 1 with a usage message.)

The CLI writes `~/.siltpoke/mute.json` with the expiry timestamp. The
Stop-hook router checks this file BEFORE any other gate (including
`/siltpoke-wake` bypass) — mute beats wake. While mute is active,
Code Review does not fire.

Tell the user verbatim from the CLI output (it includes the wall-clock
expiry time). Then mention:

- The `/siltpoke` state card shows a "muted until ..." line while
  active so they don't forget.
- `/siltpoke-unmute` clears the mute marker immediately.
- Expired mutes auto-release; no need to clean up if they walked away.
- If they want JSON for scripting: `bun ... mute.ts 1h --json`.
