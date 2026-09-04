# Siltpoke

> A coding companion for CLI agents. It codes with you. And grows with you.

**[Landing page](https://siltpoke.com/)** ·
**[Docs](https://siltpoke.com/docs.html)** ·
**[Discord](https://discord.gg/CEKyzEJdQ)**

## What it is

Siltpoke is an **independent second mind** that rides along while you
build with your CLI coding agent. It catches what you missed, helps you
understand the codebase you shipped, and learns what you actually care
about — a pet that earns its opinions, remembers your projects, and is
wholly yours. On the token budget you already have.

**🌐 [siltpoke.com](https://siltpoke.com)**

```
 /\_/\
 (>.<)        "looks clean — 2 hunks, tests green. ship it."
 > _ <
 Mochi
 Apprentice
L7 820/1750
```

Not five tools — **one nervous system**, four organs keyed to a single
project:

- **Code Review.** A *separate* `claude -p` subprocess (your existing Claude
  Code login — no extra LLM bill) reviews each turn with its own prompt
  and personality, catching what the writing-side Claude missed. Every
  claim is asked to cite file:line evidence, and the ones that do are
  marked verified — so you can see at a glance which findings are grounded
  and which are the reviewer thinking out loud. Reviews land on disk — you
  forward, dismiss (it learns), or ignore. Pull, never push.
- **Code-map.** A structural map of your codebase it can reason over —
  ask it to explain a file or symbol, grounded in the real call graph.
- **Memory.** Bugs fingerprinted across sessions; facts you tell it
  remembered across projects. Data stays on your disk — no siltpoke
  cloud, no telemetry.
- **Chat.** Talk to it with all of the above in context.

And it's a **Tamagotchi** — pet it, level it up, unlock poses. The pet
is the surface that makes it feel like a companion, not a dashboard.
Runs **~$0.04–$0.10/day** on typical use, thanks to prompt caching.

## Setup (90 seconds)

### Claude Code

```
/plugin marketplace add Siltpoke/siltpoke
/plugin install siltpoke
/siltpoke-setup
```

Siltpoke's reviewer runs on [Bun](https://bun.sh/). If you don't have it:
`curl -fsSL https://bun.sh/install | bash`

`/siltpoke-setup` creates your pet (name, species, language, personality —
`AskUserQuestion` cards, no terminal wizard), puts its face in your
statusline (wraps one you already have), and installs the dashboard
daemon. Restart Claude Code and the face appears.

Want to skip the questions? `/siltpoke-setup` has an **express** option — one
confirmation for a default pet (a slime, its own personality, your language) —
or take the full custom flow to shape species, name, and the five personality
dials yourself.

Reviews run on your existing `claude` CLI by default — no extra model to
install, no extra bill. Want reviews to stay entirely on your machine
instead? Ask Siltpoke to set up a local model (Ollama); it's not on by
default (a several-GB download) but it's one ask away.

Trouble? `/siltpoke-doctor` runs an install-health checklist, or see
[docs § Troubleshooting](https://siltpoke.com/docs.html#troubleshooting).

**Already running Siltpoke from source?** `bun run setup` still works.
Running `/siltpoke-setup` migrates you onto the plugin and turns off the
old Stop hook in `settings.json`, so reviews don't fire twice.

### Codex

**Plugin-native (recommended):**

```bash
codex plugin marketplace add https://github.com/Siltpoke/siltpoke
codex plugin add siltpoke
codex plugin list                         # verify: siltpoke … installed, enabled
```

This installs Siltpoke with reviews included — the review Stop hook + SessionStart baseline hook ride the plugin itself, no source clone needed. You'll need Bun installed (`curl -fsSL https://bun.sh/install | bash`) since the bundled hooks are Bun-compiled, but that's the only external dependency.

**From source (alternative path):**

If you prefer to install from a local clone:

```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run setup --agent codex   # wire Codex hooks, autostart (optional)
codex plugin marketplace add ~/siltpoke   # also install the skill
codex plugin list                         # verify: siltpoke … installed, enabled
```

**In Codex there are no `/siltpoke-*` slash commands** — typing
`/siltpoke` will never autocomplete; that surface is Claude Code only.
The Codex entry points are:

- nothing at all — the review hook runs by itself after each turn;
- `/skills` → pick `siltpoke`, or just ask in natural language:
  "open the Siltpoke dashboard", "show my Siltpoke inbox";
- the reviewer Brain runs on `claude -p` by default — keep the Claude CLI
  installed and logged in even for Codex-only use. Alternatively, set
  `"reviewer_provider": "codex"` in `~/.siltpoke/config.json` to have the
  reviews produced by Codex itself (cross-family review: the reviewer
  doesn't share the writer's blind spots) — see MANUAL §"Reviewer Brain
  provider" for the quota-billing and eval-gate caveats.

#### CodeBuddy / Qoder

**Plugin-native (recommended):**

Both are Claude Code forks, so they reuse the existing `.claude-plugin/` —
it auto-discovers `hooks/hooks.json` and expands `${CLAUDE_PLUGIN_ROOT}`,
so plugin-native install works the same way as Claude Code and Codex.

CodeBuddy (binary `codebuddy`):

```bash
codebuddy plugin marketplace add https://github.com/Siltpoke/siltpoke
codebuddy plugin install siltpoke@siltpoke
```

Qoder (binary `qodercli`, not `qoder`):

```bash
qodercli plugin marketplace add https://github.com/Siltpoke/siltpoke
qodercli plugin install siltpoke@siltpoke
```

The **`@siltpoke` marketplace qualifier is required** — a bare
`codebuddy plugin install siltpoke` (or the `qodercli` equivalent) fails with
`Marketplace 'undefined' is not ready`. Restart CodeBuddy, or run
`qodercli /plugins reload` (or restart Qoder), to load the plugin hooks.
Review runs plugin-native, no source clone needed. Like Codex, you'll need
Bun installed (`curl -fsSL https://bun.sh/install | bash`) since the bundled
hooks are Bun-compiled.

**From source (fallback):**

```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run setup --agent codebuddy,qoder
```

Wires Siltpoke's Stop + SessionStart hooks directly into
`~/.codebuddy/settings.json` / `~/.qoder/settings.json`. Siltpoke only wires
a fork it detects; it never installs the fork binary for you.

#### Antigravity (agy)

**Plugin-native (recommended, local clone):**

agy `plugin install <target>` actually accepts a local directory, a
`https://github.com/...` URL (agy git-clones the repo's default branch), or
a `name@marketplace` form (agy's own BUILT-IN marketplaces only — there's no
user-registerable marketplace, so a `siltpoke@siltpoke` github-marketplace
shorthand like CodeBuddy/Qoder's isn't reachable that way). The github-URL
form clones a repo's ROOT, and this repo's root has a `.claude-plugin/` that
makes agy register `source: "claude-code"` — which never fires (see below)
— so today's recommended install still points at a local clone's
`.antigravity-plugin/` subdir:

```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run build:dist   # populates .antigravity-plugin/{hooks,dist}/ (git-ignored, build-generated)
agy plugin install ~/siltpoke/.antigravity-plugin
```

Install the **`.antigravity-plugin/` subdir specifically, not the repo
root** — agy auto-detects the repo root's `.claude-plugin/` and registers
that as `source: "claude-code"`, and agy only fires Stop hooks for
`source: "antigravity"` plugins, so a repo-root install ships fine but
silently reviews nothing. `.antigravity-plugin/` is self-contained
(`build:dist` copies the Stop wrapper + bundle into it), so installing it
directly registers `source: "antigravity"` and the Stop hook fires — proven
end-to-end on a real edit. Run
`agy plugin validate ~/siltpoke/.antigravity-plugin` to confirm the install.
`agy plugin install https://github.com/Siltpoke/siltpoke` does NOT work
yet — it clones the repo root, which registers as `source: "claude-code"`
and silently reviews nothing (same failure as above), and agy always clones
the default branch (branch/subdir qualifiers in the URL are ignored). A
working github one-liner needs a **dedicated repo whose default-branch root
is the antigravity manifest**, synced from `.antigravity-plugin/` — a
tracked follow-up, not published yet. It is
not a marketplace mechanism: agy's marketplaces are built into the binary,
not user-registerable.

**From source (alternative, also the only route under headless `agy -p`):**

```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run setup --agent agy
```

`bun run setup` wires Siltpoke into Antigravity's own hook system
(`~/.gemini/config/hooks.json`, read-modify-write — other named hooks you
already have are left untouched) when the `agy` CLI is on your PATH. This
source-install path is preserved deliberately: it's the only route that also
works under headless `agy -p`, since the plugin path's `-p` payload sends an
empty workspace (`workspacePaths: []`) and can't be reviewed. Reviews fire
on every turn that changes code, and the pet face renders in agy's
statusLine too. Like CodeBuddy/Qoder, Siltpoke wires agy only if it's already
installed — it never installs the CLI for you. Antigravity's Stop hook is
synchronous, so siltpoke dispatches the review to a background process and
hands control back to agy immediately — you should not notice any added
latency in your agy session.

## Use it with project-life-cycle

Pairs well with
[project-life-cycle](https://github.com/Siltpoke/project-life-cycle)
— a Claude Code skill adding spec → plan → execute → ship → release
discipline (`/init-harness` → `/ship` → `/release`). project-life-cycle
structures the work; Siltpoke reviews it and remembers what broke.
Better together, fully independent.

```bash
claude plugin marketplace add Siltpoke/project-life-cycle
claude plugin install project-lifecycle@project-life-cycle
```

## Daily use

In Claude Code there are only 10 commands — everything else (review
history, chat, memory, timeline, code-map) lives in the dashboard, not
behind a slash command. This list is the whole set; there is no hidden
one:

```
/siltpoke-setup                   Create/recreate your pet, redo install
/siltpoke-last                    Pull the most recent review into the chat
                                  (and record that it landed — this is the
                                  only path a review reaches a conversation)
/siltpoke-dashboard               Open dashboard → http://127.0.0.1:9876
/siltpoke-brain                   Show or set which CLI + model reviews your code
/siltpoke-mute <duration>         Silence reviews (pair-programming, demos)
/siltpoke-unmute                  Clear an active mute
/siltpoke-doctor                  Install-health checklist
/siltpoke-restart-daemon          Restart the dashboard daemon (stop + start)
/siltpoke-menubar <cmd>           Pet in the macOS menu bar via SwiftBar (install/status/remove)
/siltpoke-help                    The full manual, generated from the CLI itself
```

Reviewing a review itself — marking one **seen** or **wrong** — is not a
command. Those are the `ACK` / `DISMISS` buttons on each row in the
dashboard's review history, because a button you can see beats a command
you have to remember.

Full reference (including how to switch the reviewer to a local Ollama
model): **`/siltpoke-help`** in-chat, or
[docs § Slash commands](https://siltpoke.com/docs.html#slash-commands).

In Codex, use the Siltpoke skill/plugin surface instead of slash
commands: ask naturally for "Siltpoke inbox", "Siltpoke memory", or
"open Siltpoke dashboard".

## Uninstall

**Installed via the plugin?** `/plugin uninstall siltpoke` removes the
plugin (commands + hooks). Your pet's data stays in `~/.siltpoke/` —
delete that folder yourself if you want it gone too (there's no
automated purge for plugin installs yet).

**Installed from source?**

```bash
bun run uninstall              # restore settings, keep data
bun run uninstall -- --purge   # restore + nuke ~/.siltpoke/
```

## License

Siltpoke is **source-available** under the
[PolyForm Perimeter License 1.0.1](./LICENSE).

You're free to use, modify, and share it for **any purpose** — including inside a
for-profit company's own work — **except** building or offering a product that
competes with Siltpoke. That includes repackaging or reselling it, bundling it
into a paid product, or offering a hosted / SaaS version of it.

Want to bundle, resell, or host Siltpoke commercially? That needs a separate
commercial license — reach out at **jd.victoria.work@gmail.com**.

Copyright (c) 2026 Jiaqi Duan. All rights reserved.
