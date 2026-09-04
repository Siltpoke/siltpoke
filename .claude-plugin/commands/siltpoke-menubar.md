---
description: Put the Siltpoke pet in your macOS menu bar (via SwiftBar). Subcommands install / status / remove.
---

The user wants the pet in their macOS menu bar (a separate surface from the
statusline and the dashboard). This uses SwiftBar. Substitute the subcommand
the user intends for `<install|status|remove>` below — use `status` if they
just say "menubar" without saying what to do:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" menubar <install|status|remove>
```

Subcommands: `install` (add the pet to the menu bar), `status` (is it
installed?), `remove` (take it out). Running the command IS the consent —
there is no interactive prompt.

Translate for the user:

- `✓ menu-bar pet installed.` — it's live; the pet appears in the menu bar
  (SwiftBar refreshes it every minute).
- `SwiftBar isn't installed …` (reason `no-swiftbar`) — the menu-bar pet
  needs the free SwiftBar app. Give them the link it printed
  (https://github.com/swiftbar/SwiftBar) and tell them to re-run
  `/siltpoke-menubar install` once it's installed.
- `menu-bar pet: installed` / `not installed` — from `status`.
- `✓ menu-bar pet removed.` — from `remove`.
- `the menu-bar pet is macOS-only.` — they're not on a Mac; nothing to do.

Keep the response to one sentence. Don't show the raw output.
