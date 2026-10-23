---
description: Remove what Siltpoke set up on this machine — one thing at a time, each only after the user says yes.
---

The user wants Siltpoke gone. Removing the plugin (`claude plugin uninstall
siltpoke`) does NOT undo what setup changed outside the plugin's own folder:
the status line keeps showing the pet, and the user's own status line does not
come back. This command undoes those changes, **one group at a time, and only
the groups the user says yes to**.

## 1. Show the plan

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" uninstall --plan
```

This changes nothing. It prints what Siltpoke finds on this machine, in groups
(`[claude-code]`, `[dashboard]`, `[menubar]`, …), and a plan id. Show the user
the whole output, in their language. Do not summarise a group away.

## 2. Ask about one group, then remove that one group

Take the groups in the order printed. Skip any group marked `(listed only)` or
`(only with --purge)` — say they are being left, and why (the line says why).

For each remaining group: ask the user whether to remove it, and wait for the
answer. On a yes, run exactly one command for that one group:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" uninstall --plan-id <id> --remove <group>
```

- `<group>` is the name inside the brackets. One `--remove` per command: the
  CLI refuses two.
- The last line of the output is `plan is now <new id>`. Always use that id
  for the next group: once something was removed the old one is refused.
- The lines above it say what that call removed (`Removed: N items`) and name
  anything that is still there after a yes (`Not removed — still there:`).
- Never run `--remove` for a group the user has not just said yes to. A general
  "remove everything" is not a yes to each group: still ask, one at a time.
- Do not add `--purge`. Deleting the user's data is not this command's job
  (step 4).

Pass on what each command printed, including any line starting with `!`.
Exit code 2 means the CLI refused and changed nothing: read its message, run
`--plan` again, and show the new plan.

## 3. Show the report

After the last group has been asked about — whatever the answers were:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" uninstall --report
```

This changes nothing. Show the user the whole output, in their language. Keep
the "Not tracked" part: it says what Siltpoke cannot know. Do not tell the
user the machine is clean, in any words — the report does not say that, and
neither should you.

## 4. Tell the user what is left, in this order

Both are typed in a terminal, by the user, not here:

1. `claude plugin uninstall siltpoke` — removes the plugin. Only the host can
   do this. If the plugin was installed for one project only (scope `local` or
   `project`), that command answers "not installed in user scope": it has to
   be run in that project's folder with `--scope local` or `--scope project`
   added. Say so when you do not know how it was installed; step 2 says what
   to run if the plugin is still there.
2. `sh ~/.siltpoke/bin/uninstall.sh --purge` — optional. It asks about each
   remaining thing, the data in `~/.siltpoke` (the pet, its memory, the review
   history) included. Only after step 1 and after Claude Code is closed: while
   the plugin is installed, its hooks write the folder straight back.

Do not run `claude plugin uninstall` yourself, and do not delete `~/.siltpoke`
or anything else yourself. `bun`, `git` and the other tools Siltpoke needs may
be used by things that have nothing to do with Siltpoke.
