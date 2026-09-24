You are installing Claude Code plugins for me, setting them up, and then teaching me to use them. Talk to me in the language I am writing in. Keep each message short. **Ask me before anything that downloads and runs a script, installs an app, or changes my shell profile.**

There are two plugins. They are independent — I can have one, the other, or both:
- **Siltpoke** — a second reviewer that watches my coding sessions. After each turn, a *separate* AI process reads what changed and writes down what it thinks was missed. It remembers bugs across sessions, and it has a dashboard and a small pet. Repo: https://github.com/Siltpoke/siltpoke
- **Project Life Cycle (PLC)** — a working method for AI coding: spec → plan → build → verify → ship → release, with commands to set up a project, ship a feature, save/resume a session, and cut a release. Repo: https://github.com/Siltpoke/project-life-cycle

## Before anything — am I on Windows?

Run `uname -s`. If it fails, or prints anything that is not `Darwin` or `Linux`
(on Windows it will not exist, or a Git-Bash shell prints `MINGW64_NT-...`),
**stop here and tell me this, in my language, before installing anything:**

> Siltpoke does not support native Windows yet. It will install, the pet will
> appear, the commands will work and the config will say the setup is fine —
> but the review hook is registered as `sh ./hooks/stop.sh`, Windows has no
> `sh`, so no review will ever run and nothing will say so. If you have WSL,
> run this again inside WSL and everything works, because that is Linux.
> Otherwise, wait for native Windows support.

Then ask whether I want to continue anyway. **Do not install unless I say yes**,
and if I do, say once more that reviews will not fire. Project Life Cycle has no
such problem — it is prompts and commands, no hook — so offer to install only
PLC instead.

## Step 0 — What do I already have, and what do I want?

Run `claude plugin list` first. Then:
- If one of them is already installed, say so in one line ("you already have PLC — this time I'll only add Siltpoke") and skip its install. Offer `claude plugin update <name>` instead.
- For anything not installed yet, ask me once: **both / only Siltpoke / only PLC**. Recommend "both" in one sentence, but do what I pick. Every later step applies only to what I picked.

## Step 1 — Check the tools

Run these and tell me in one line each what you found:
- `claude --version` (must work — you are running inside it)
- `git --version`
- `uname -s` (tells you if I'm on a Mac — only matters for the menu-bar pet in Step 4)
- Siltpoke only: `bun --version`. Siltpoke's reviewer runs on Bun. If it is missing, **ask me first**, then run `curl -fsSL https://bun.sh/install | bash` and check again with `~/.bun/bin/bun --version` (my shell will not see the new PATH until it restarts — that is fine, setup records the full path).

## Step 2 — Install

Run with the Bash tool, one line at a time. If any line fails, stop and show me the exact error.

```bash
# PLC
claude plugin marketplace add Siltpoke/project-life-cycle
claude plugin install project-lifecycle@project-life-cycle

# Siltpoke
claude plugin marketplace add Siltpoke/siltpoke
claude plugin install siltpoke@siltpoke
```

Then run `claude plugin list` and confirm each one I picked shows as installed and enabled. Do not claim success from the install output alone.

## Step 3 — Set up Siltpoke (skip if I did not pick it)

The `/siltpoke-setup` command is not available until Claude Code restarts, but its instructions are already on disk:

1. Find the plugin folder: `ls -d ~/.claude/plugins/cache/siltpoke/siltpoke/*/ | sort -V | tail -1`. Call it `PLUGIN_ROOT`.
2. Read `PLUGIN_ROOT/.claude-plugin/commands/siltpoke-setup.md` (if it is not there: `find PLUGIN_ROOT -name siltpoke-setup.md`).
3. Follow that file exactly, as if I had typed `/siltpoke-setup`. Wherever it says `${CLAUDE_PLUGIN_ROOT}`, use the real `PLUGIN_ROOT`. If `bun` is not on PATH yet, use `~/.bun/bin/bun`.
4. It first asks me **Express** (one step, a default pet) or **Custom** (choose species, name, language, personality). Let me choose.
5. When it finishes, tell me the result in plain words. If it fails, translate the one-line error and stop.
6. If `~/.siltpoke/config.json` already existed before you started, setup was done before: say so, ask if I want to redo it, and skip to Step 4 if not.

## Step 4 — The menu-bar pet (Siltpoke + Mac only)

If setup already offered the menu-bar pet and I answered, skip this step. Otherwise, explain it in two sentences and ask if I want it:

- **The terminal pet (statusline)** sits in the bottom line of Claude Code. It shows **this session only**: it changes after every turn, and its speech bubble carries the latest review. You see it only while you are in that Claude Code window.
- **The menu-bar pet** sits in the Mac's top menu bar and shows **all your sessions at once** — every project, and every coding tool Siltpoke watches. You see it all the time, even with every terminal closed. The number next to it is how many sessions have a recent review (not a count of problems). Click it for a list: one line per session (project · branch · time · which coding tool wrote the code) with its latest review, plus "Open dashboard" and "Restart daemon". It refreshes once a minute, not after every turn.

If I say yes:
1. It needs the free app SwiftBar. Check with `ls /Applications/SwiftBar.app`. If it is missing, ask me: install with `brew install --cask swiftbar` (only if `brew --version` works), or let me download it myself from https://github.com/swiftbar/SwiftBar. Then open it once: `open -a SwiftBar` (the first time, it asks me to pick a plugin folder — accept the default).
2. Run `bun "PLUGIN_ROOT/dist/siltpoke-cli.js" menubar install`, then `… menubar status`, and tell me in one sentence what it said.

## Step 5 — PLC needs no global setup (skip if I did not pick it)

Tell me: PLC is set up **per project**, not once for the whole machine. Inside a project folder, `/init-harness` looks at the code, writes a `CLAUDE.md` and a few config files, and asks before overwriting anything. Do **not** run it now. If my current folder is a git repo, say: "after the restart, you can run `/init-harness` here."

## Step 6 — The one thing I must do myself

Tell me clearly: **quit Claude Code and start it again now.** Slash commands, the Siltpoke review hook, and the terminal pet only load on restart. Then tell me what to type first after the restart (Step 7, item 1).

## Step 7 — Getting started: my first day

Before the restart, print this walkthrough in my language, only the parts for what I installed, filled with my real results. Make it a numbered list I can follow step by step. Do not invent commands that are not listed here.

**Siltpoke — first 10 minutes**
1. Type `/siltpoke-doctor`. It prints a ✓/✗ checklist. All ✓ means the install works. If something is ✗, it says what to do.
2. Ask Claude for any small real change (for example: "add a comment explaining this function"). When Claude finishes, Siltpoke reviews the change in the background. You do not need to do anything.
3. Watch the terminal pet: its face and speech bubble change when the review is done. (On a Mac with the menu-bar pet, the menu bar shows it too, within a minute.)
4. Type `/siltpoke-last` to read the full review in the chat.
5. Type `/siltpoke-dashboard`. It opens http://127.0.0.1:9876 — review history, chat with your pet about your code, what it remembers, and the Code Map. On a review, press **ACK** (seen, useful) or **DISMISS** (wrong). This is how it learns what to stop saying.
6. Need quiet (a demo, pairing)? `/siltpoke-mute 1h`, and `/siltpoke-unmute` to undo. Reviews stopped showing up? `/siltpoke-wake`.

**PLC — your first project**
1. `cd` into a project and type `/init-harness`. Answer its questions. It writes `CLAUDE.md` and asks before overwriting anything.
2. Talk about the code first, no edits: "explain how this project is structured."
3. Build one small feature with `/ship <what you want>`. It stops 3 times to check with you: the user story, the spec, and the pull request.
4. Stopping for the day? `/handoff` saves where you are to `RESUME.md`.
5. Next time, start with `/catchup` — a "welcome back" card of where you left off.
6. The `project-lifecycle` skill also turns on by itself when you start a project or plan multi-step work. You do not have to type the commands — they are shortcuts.

**Both together — a normal day**
1. Open a project → `/catchup`
2. Build with `/ship`, or just work normally
3. Siltpoke reviews each turn in the background → `/siltpoke-last` when the pet looks worried
4. Leaving → `/handoff`

## Step 8 — Keep using it

Print this right after the first-day walkthrough, in my language, only the parts for what I installed. It is how I use the plugins every day after the first one.

**Siltpoke, every day**
1. Just work. Siltpoke reviews each turn by itself — you never have to start it.
2. When the pet looks worried (or the menu-bar number goes up), read the review: `/siltpoke-last`.
3. Teach it. In the dashboard (`/siltpoke-dashboard`), press **DISMISS** on a review that is wrong and **ACK** on one that helped. It remembers, and over time stops repeating what you dismissed.
4. Once a week, look at the dashboard's Memory page — that is what it has learned about your code.
5. Reviews went quiet? `/siltpoke-doctor` first; if everything is ✓, `/siltpoke-wake`.
6. Busy (a demo, pairing)? `/siltpoke-mute 1h` — it turns itself back on when the time is up.

**PLC, every session**
1. Start: `/catchup` — where you left off, what shipped, what is next.
2. New feature: `/ship <what you want>`.
3. A design question you are not sure about: `/research <question>` — it comes back with cited sources.
4. Before merging a branch: `/review`.
5. End: `/handoff`. The next session starts again at item 1.
6. Ready to publish a version: `/release`.

**Keep it current:** `claude plugin update siltpoke` · `claude plugin update project-lifecycle`, then restart Claude Code.

## Step 9 — The manual

End with this, in my language, only the rows for what I installed:

| | Status |
|---|---|
| Project Life Cycle | installed — version from `claude plugin list` |
| Siltpoke | installed — version, pet name + species |
| Bun | version (and its path) |
| Menu-bar pet | installed / not installed / not a Mac |
| **Still to do** | restart Claude Code → `/siltpoke-doctor` (Siltpoke) · `/init-harness` in a project (PLC) |

Siltpoke commands: `/siltpoke-last` · `/siltpoke-dashboard` · `/siltpoke-doctor` · `/siltpoke-mute <duration>` / `/siltpoke-unmute` · `/siltpoke-wake` · `/siltpoke-brain` (which model reviews — can be another company's CLI or a local model) · `/siltpoke-menubar` · `/siltpoke-help` (the full manual).

Cost: the review uses your existing Claude Code login — no extra account. Roughly $0.04–$0.10 a day with prompt caching. Reviews are saved on your machine; nothing is sent anywhere except the normal model call and a once-a-day check with GitHub for the latest version number — that check sends nothing about you or your code, and Siltpoke receives nothing. Turn it off with `"updateCheck": {"enabled": false}` in `~/.siltpoke/config.json`.

PLC commands: `/init-harness` · `/ship` · `/review` · `/research` · `/handoff` · `/catchup` · `/release`. If another plugin uses the same name, use the long form, e.g. `/project-lifecycle:ship`.

Uninstall: `claude plugin uninstall siltpoke` · `claude plugin uninstall project-lifecycle@project-life-cycle`
Want the other plugin later? Paste this same prompt again — it only adds what is missing.
