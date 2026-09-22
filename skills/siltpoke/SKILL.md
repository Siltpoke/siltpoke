---
name: siltpoke
description: Use when the user wants to install, inspect, open, or operate Siltpoke from Codex or Antigravity (agy); includes setup, dashboard, inbox, memory, code-map, and review workflows. Does not replace Siltpoke's local installer.
---

# Siltpoke

Siltpoke is a local-first coding companion for CLI agents. It reviews your
work in the Stop hook, but reviews only fire once a pet exists at
`~/.siltpoke/config.json` — until then the hook is silently gated off. In
Codex or Antigravity (agy), use this skill both to CREATE that pet (a
plugin-native install has no slash commands and no source clone, so this
skill is the only path in) and to route every other request to the bundled
Siltpoke CLI and dashboard.

This skill is self-contained: do not read or defer to any Claude Code
command file (`.claude-plugin/commands/*.md`) — neither Codex nor agy can see
those files. Everything needed to run the flows below is written out here.

## Resolve the plugin root first

Every command below needs the plugin's install directory. A skill-run shell
command's cwd is the user's project, not the plugin root, and neither Codex
nor agy is guaranteed to export a `${CLAUDE_PLUGIN_ROOT}`-equivalent env var
to a skill-run shell. Resolve it once per session with this ladder — each
rung is skipped when it yields nothing, and the resolved value is validated
before use so a missing install fails loudly instead of turning every later
`bun` command into a confusing "module not found":

```bash
PLUGIN_ROOT=""
for _candidate in "${ANTIGRAVITY_PLUGIN_ROOT:-}" "${AGY_PLUGIN_ROOT:-}" "${CLAUDE_PLUGIN_ROOT:-}"; do
  if [ -n "$_candidate" ] && [ -f "$_candidate/dist/siltpoke-cli.js" ]; then
    PLUGIN_ROOT="$_candidate"
    break
  fi
done
if [ -z "$PLUGIN_ROOT" ] && command -v codex >/dev/null 2>&1; then
  _candidate=$(codex plugin list --json 2>/dev/null | jq -r '.installed[]? | select(.name=="siltpoke") | .source.path' 2>/dev/null)
  if [ -n "$_candidate" ] && [ -f "$_candidate/dist/siltpoke-cli.js" ]; then
    PLUGIN_ROOT="$_candidate"
  fi
fi
if [ -z "$PLUGIN_ROOT" ] && [ -n "${HOME:-}" ] && [ -f "${HOME}/.gemini/config/plugins/siltpoke/dist/siltpoke-cli.js" ]; then
  PLUGIN_ROOT="${HOME}/.gemini/config/plugins/siltpoke"
fi
if [ -z "$PLUGIN_ROOT" ]; then
  printf '%s\n' "Could not find a Siltpoke plugin install (checked ANTIGRAVITY_PLUGIN_ROOT / AGY_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT, codex plugin list, and ~/.gemini/config/plugins/siltpoke)." >&2
fi
```

Rungs, in order: **(a)** an env var already set for this host —
`ANTIGRAVITY_PLUGIN_ROOT` / `AGY_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`. Whether
agy exports either of the first two to a skill-run shell is UNVERIFIED; this
rung is free to try and costs nothing when the var is unset. Every variable the
block reads — `HOME` included — is read through `${VAR:-}`, so a caller running
with `set -u` gets the designed "could not find" message rather than a raw
`parameter not set` abort. **(b)** the
codex form, run only when a `codex` binary is present on PATH. This rung needs
`jq`; the block does NOT carry a `jq`-less fallback, it just yields nothing and
falls through. So on a codex box with no `jq`, if rung (c) does not save you
either, resolve the path yourself from `codex plugin list`'s plain-text PATH
column (or a `python3 -c` one-liner over the same `--json` output) before
running anything below. **(c)** the agy
form — agy installs the whole plugin directory, `dist/` included, to
`$HOME/.gemini/config/plugins/siltpoke`. A rung only counts once
`dist/siltpoke-cli.js` is confirmed to exist under the candidate path — an
untested guess is not a resolution.

If every rung fails, `PLUGIN_ROOT` stays empty and the snippet says so on
stderr. **Stop there and tell the user plainly that their Siltpoke install
couldn't be found automatically, and ask where it's installed** — do not
proceed with an empty `$PLUGIN_ROOT`. Once resolved, every command in this
skill is `bun "$PLUGIN_ROOT/dist/<entrypoint>"`.

## Create your pet (first-time setup)

1. **Check for an existing pet.** Look for `~/.siltpoke/config.json`
   (expand `~` to the user's real home).
   - **If it exists**, this is a *reconfigure*, which is out of scope here —
     do NOT overwrite it automatically. Tell the user their pet is already
     configured and that changing it means re-running the same
     `siltpoke-configure.js --answers-file` command below with a fresh
     answers file of their new choices. Stop; do not proceed to step 2.
   - **If it is absent**, proceed to create one.

2. **Have the creation conversation.** Ask in prose, in the user's language —
   this is meeting a new pet, not filling out a form.

   **a. Species — present all 5, exactly these (the kernel validates against
   this list and refuses anything else):**
   - **slime** (default) — squishy, unbothered, all-round neutral.
   - **cat** — sharp, impatient, low-key judging your code.
   - **owl** — patient, rigorous, wants the evidence.
   - **robot** — terse, exacting, all rigor no small talk.
   - **bunny** — gentle, chatty, endlessly patient.

   **b. Name — offer either:**
   - Type their own — anything they like.
   - Auto-rolled — run this, passing ONLY one of the five literal species
     words above (never other user-typed text, since it lands on a live
     command line):
     ```bash
     bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" random-name <species>
     ```
     Show the result; re-roll as many times as they like by running it again.

   **c. Personality — the five dials, each an integer 0-10:**
   - **snark** — 0 = sweet, 10 = savage.
   - **patience** — 0 = trigger-happy at mistakes, 10 = saintly.
   - **rigor** — 0 = vibes-based, 10 = methodical, cites evidence.
   - **chattiness** — 0 = terse, 10 = verbose bubbles.
   - **curiosity** — 0 = by-the-book, 10 = always suggesting alternatives.

   Offer three ways to arrive at them, and let the user pick:
   - **Species default** — skip asking; leave the `dials` key out of the
     answers file entirely in step 3 (each species has its own built-in
     profile; do NOT substitute `5` for every dial — that silently hands
     every species the same flat profile the kernel would not have chosen).
   - **Customize** — ask each of the five in turn, explaining both poles,
     and use what the user says verbatim.
   - **Quick roll** — pick five plausible 0-10 integers yourself and read
     them back for confirmation.

   **d. Language** — infer the language this conversation is happening in;
   read it back in one line for confirmation. Fall back to `en` only if
   truly unclear.

3. **Write the answers with the file-write tool — NOT the shell.** The name,
   species, and language are user text and could contain shell
   metacharacters (a name like `"; rm -rf ~; #` would execute if
   interpolated into a shell command). Use the agent's file-write tool
   (never a shell) to create `<HOME>/.siltpoke/.setup-answers.json` — where
   `<HOME>` is the user's ABSOLUTE home path (resolve `~`/`$HOME` yourself; the
   file-write tool does not expand shell variables). On a truly fresh install
   the `<HOME>/.siltpoke/` directory may not exist yet (the SessionStart nudge
   that would create it may not have run), so ensure that directory exists
   first (e.g. `mkdir -p "$HOME/.siltpoke"` in the shell — a fixed path with no
   user text, so it is injection-safe). The answers JSON:

   ```json
   {
     "name": "<name>",
     "species": "<one of the 5 species words>",
     "language": "<inferred language>",
     "dials": {
       "snark": 5,
       "patience": 5,
       "rigor": 5,
       "chattiness": 5,
       "curiosity": 5
     },
     "statusline": true,
     "daemon": false
   }
   ```

   The all-`5` dials above are only a **shape illustration**, NOT the
   "species default" — do not copy those literal fives.
   Use the actual five dial values chosen in step 2c. **If the user chose
   "Species default," omit the whole `dials` block** (drop those lines) so
   the kernel fills in that species' own profile. Put name/species/language
   in verbatim — these are JSON string values, not shell words, so do not
   escape or sanitize them. Keep `"statusline": true` (installs the pet's
   face into the statusline) and `"daemon": false` (the daemon stays
   opt-in — core review runs in the Stop hook without it; the user can start
   it later via the dashboard command below).

4. **Run the bundled configure kernel** — one fixed path, zero user data on
   the command line:

   ```bash
   bun "$PLUGIN_ROOT/dist/siltpoke-configure.js" --answers-file "$HOME/.siltpoke/.setup-answers.json"
   ```

   It validates `species` against the 5-item list and each dial as an
   integer 0-10, writes `~/.siltpoke/config.json`, wires the statusline into
   `~/.claude/settings.json`, and deletes the answers file on success. It
   asks nothing further — no host picker, no overwrite confirmation.

5. **Translate failures, don't dump the raw trace:**
   - `command not found: bun` — Bun isn't installed; point at
     `curl -fsSL https://bun.sh/install | bash`, then retry.
   - `unknown species "<x>" …` — a species outside the 5 above was sent; no
     config was written. Re-ask, rewrite the answers file, retry.
   - `dial "<k>" must be an integer 0..10 …` — a dial was out of range or
     non-integer; no config was written. Re-collect dials, rewrite, retry.
   - `missing --name` — the name came through empty; ask again.
   - `cannot read --answers-file …` / not valid JSON — the file wasn't
     written or is malformed; rewrite it with the file-write tool and retry.
   - a `settings.json is not valid JSON` warning is NOT fatal — the pet was
     created, only the statusline wiring was skipped; tell the user to fix
     their `~/.claude/settings.json` and re-run step 4.

6. **Confirm success.** Once step 4 exits clean, tell the user their pet is
   created and Siltpoke reviews are now active (the Stop hook's config gate
   now passes). Mention: restart Codex/Claude Code for the statusline face
   to appear, and that `doctor` below can verify the whole install.

## Other commands (plugin-native, bundled)

Everything below routes through the same bundled entrypoint (matching how
Siltpoke's own shipped plugin commands invoke it), using the `$PLUGIN_ROOT`
resolved above:

- Open dashboard: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" dashboard`
- Restart dashboard/daemon: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" restart-daemon`
- Check install health: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" doctor`
- Surface the most recent review: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" last`
- Forward a review into chat: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" mark-forwarded <id-or-latest>`
- Mute reviews: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" mute "<duration>"`
- Unmute reviews: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" unmute`
- Menu-bar pet (macOS only): `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" menubar <install|status|remove>`
- Manual / command list: `bun "$PLUGIN_ROOT/dist/siltpoke-cli.js" help`

**Not yet available to a plugin-native install:** listing/dismissing pending
reviews, `remember`, repo indexing, and the code-map/`explain` workflow are
not bundled into `dist/siltpoke-cli.js` today — they only exist as source
scripts (`bun src/cli/list-inbox.ts`, `dismiss.ts`, `remember.ts`,
`index-repo.ts`, `graph.ts`, `explain.ts`) that require a source clone. Tell
the user plainly if they ask for one of these that it needs a source
checkout, rather than guessing at a bundled command that doesn't exist.

## Host Integration Notes

- The pet is created entirely through this skill's step-by-step flow above —
  there is no `bun run setup` wizard available to a plugin-native install on
  ANY host (that script needs a source clone this user doesn't have).
- **Codex**: use this skill as the command surface. Do not tell users to run
  `/prompts:siltpoke-report`; current Codex CLI does not recognize that
  route. The Codex Stop hook currently routes through
  `src/hooks/codex-stop.ts`, which adapts Codex hook input into Siltpoke's
  existing Stop-hook pipeline.
- **Antigravity (agy)**: use this skill as the command surface the same way —
  agy has no verified `/siltpoke-*` slash form either (`agy --help` shows no
  `skills` subcommand), so route natural-language requests here too.
- Siltpoke's Brain provider is still Claude CLI backed in this phase, on
  every host. Do not claim that Codex or agy is the reviewer brain unless a
  later provider-abstraction phase has landed.

## Response Style

When you run a Siltpoke CLI, summarize the result in one or two sentences.
Show raw output only when the user asks for it or the command is diagnostic.
