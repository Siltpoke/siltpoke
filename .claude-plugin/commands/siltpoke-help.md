---
description: Siltpoke manual — every command, where the dashboard is, which model does the reviewing.
---

The user wants to learn how to use Siltpoke. Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" help
```

Show the output to the user VERBATIM — do not paraphrase, summarize, or
re-order it. (Translate it only if the user asked in another language.)
The manual is generated from the shipped bundle, so it always lists the
commands that actually exist; a hand-written list here would drift.

Two things in it are easy to skim past. If the user's question touches
either, say it plainly rather than making them read for it:

- **The dashboard is where everything else lives.** `/siltpoke-dashboard`
  opens it. The full review history, the chat, and the code-map of the
  repo are all there — not behind slash commands. There are only 9
  commands; anything else the user is looking for is in the dashboard.
- **Reviews run through the user's own `claude` CLI by default** — that
  is what reads over Claude's shoulder, so no extra model is installed
  and no key of ours is involved. A local model (Ollama) can be used
  instead if they want reviews to stay entirely on their machine; it is
  not installed by default (several GB), but it is available on request.

If they ask a specific follow-up ("how do I stop it reviewing during a
demo?", "what does it cost?"), answer from the manual plus the config
schema, rather than dumping the whole manual again.
