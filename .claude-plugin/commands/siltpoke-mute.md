---
description: Silence Siltpoke for a duration. Mute beats everything — no review fires while it is active.
---

The user wants Siltpoke quiet for pair-programming, a demo, or a focus
block. They pass a duration as the argument.

Accepted durations — this is the COMPLETE list of legal values:
- `15m` / `30m` — minutes (`<N>m`)
- `1h` / `4h` — hours (`<N>h`)
- `1d` / `2d` — days (`<N>d`)
- `indefinite` — silent until `/siltpoke-unmute`

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" mute "<duration>"
```

Substitute `<duration>` ONLY with a value that matches `<N>m` / `<N>h` /
`<N>d` / `indefinite`. If what the user typed does not match that shape,
do NOT put it in the command — ask them again. (Their raw text must
never reach the shell; the accepted values contain nothing a shell can
act on.) If they passed nothing at all, ask them for a duration.

The CLI writes `~/.siltpoke/mute.json` with the expiry timestamp. The
Stop-hook router checks this file BEFORE any other gate (including the
wake bypass) — mute beats wake. While mute is active, no review fires.

Tell the user verbatim from the CLI output (it includes the wall-clock
expiry time). Then mention:

- `/siltpoke-unmute` clears the mute marker immediately.
- Expired mutes auto-release; no need to clean up if they walked away.
- The dashboard (`/siltpoke-dashboard`) shows the mute while it is active.
