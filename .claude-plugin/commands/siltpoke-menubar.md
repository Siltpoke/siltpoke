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
- `menu-bar pet: installed, SwiftBar running` — from `status`; the pet is
  showing right now.
- `menu-bar pet: not installed` — from `status`; offer `/siltpoke-menubar
  install`.
- `menu-bar pet: installed, but SwiftBar is not running …` — from `status`;
  the shim is fine, the menu bar is empty only because SwiftBar isn't up.
  Offer to run the `open -a SwiftBar` it printed.
- `menu-bar pet: installed, but I cannot find SwiftBar at …` — from `status`;
  give them the link it printed. Note it only ever looks in `/Applications`, so
  if they keep apps elsewhere, say that rather than telling them SwiftBar is
  absent.
- `menu-bar pet: installed at <A>, but SwiftBar is now reading <B> …` — from
  `status`; the install succeeded, then SwiftBar's plugin folder changed. Offer
  `/siltpoke-menubar install` to put it where SwiftBar now looks.
- `menu-bar pet: installed, but I could not tell whether SwiftBar is running`
  — from `status`; the process probe itself failed. Ask them to look at their
  menu bar; do not assert either way.
- `✓ menu-bar pet removed.` — from `remove`.
- `the menu-bar pet is macOS-only.` — they're not on a Mac; nothing to do.

Keep the response to one sentence. Don't show the raw output.
