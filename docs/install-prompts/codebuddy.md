You are installing CodeBuddy plugins for me, setting them up, and then teaching me to use them. Talk to me in the language I am writing in. Keep each message short. **Ask me before anything that downloads and runs a script, installs an app, or changes my shell profile or config files.**

There are two plugins. They are independent — I can have one, the other, or both:
- **Siltpoke** — a second reviewer that watches my coding sessions. After each turn, a *separate* AI process reads what changed and writes down what it thinks was missed. It remembers bugs across sessions, and it has a dashboard and a small pet. Repo: https://github.com/Siltpoke/siltpoke
- **Project Life Cycle (PLC)** — a working method for AI coding: spec → plan → build → verify → ship → release. Repo: https://github.com/Siltpoke/project-life-cycle

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

Run `codebuddy plugin list` first (if that subcommand is not available, tell me to open the `/plugin` screen and read you the **Installed** tab). Then:
- If one of them is already installed, say so in one line ("you already have PLC — this time I'll only add Siltpoke") and skip its install.
- For anything not installed yet, ask me once: **both / only Siltpoke / only PLC**. Recommend "both" in one sentence, but do what I pick. Every later step applies only to what I picked.

## Step 1 — Check the tools

Run these and tell me in one line each what you found:
- `codebuddy --version`, `git --version`, `uname -s` (a Mac? only matters for the menu-bar pet in Step 4)
- Siltpoke only: `bun --version`. Siltpoke's reviewer runs on Bun. If it is missing, **ask me first**, then run `curl -fsSL https://bun.sh/install | bash` and check again with `~/.bun/bin/bun --version` (my shell will not see the new PATH until it restarts — that is fine, setup records the full path).

## Step 2 — Install

Run one line at a time. If any line fails, stop and show me the exact error.

```bash
# Siltpoke
codebuddy plugin marketplace add https://github.com/Siltpoke/siltpoke
codebuddy plugin install siltpoke@siltpoke

# PLC
codebuddy plugin marketplace add https://github.com/Siltpoke/project-life-cycle
codebuddy plugin install project-lifecycle@project-life-cycle
```

The `@…` part is required — a bare `codebuddy plugin install siltpoke` fails with `Marketplace 'undefined' is not ready`. If the PLC lines fail as a command-line call, tell me to type these two inside CodeBuddy instead: `/plugin marketplace add Siltpoke/project-life-cycle` and `/plugin install project-lifecycle@project-life-cycle`.

Then confirm each one I picked shows as installed. Do not claim success from the install output alone.

## Step 3 — Set up Siltpoke (skip if I did not pick it)

Reviews do not start until a pet exists at `~/.siltpoke/config.json`. If that file already exists, setup was done before: say so, ask if I want to redo it, and skip to Step 4 if not.

CodeBuddy installs the same plugin files as Claude Code, so the setup instructions are on disk:
1. Find them: `find ~/.codebuddy -name siltpoke-setup.md 2>/dev/null | head -1` (if nothing, try `find ~ -maxdepth 6 -name siltpoke-setup.md -path '*siltpoke*' 2>/dev/null | head -1`). The plugin folder, `PLUGIN_ROOT`, is the folder that contains `.claude-plugin/`. Check that `PLUGIN_ROOT/dist/siltpoke-cli.js` exists.
2. Read that `siltpoke-setup.md` and follow it exactly. Wherever it says `${CLAUDE_PLUGIN_ROOT}`, use the real `PLUGIN_ROOT`. If `bun` is not on PATH yet, use `~/.bun/bin/bun`. Where it says "restart Claude Code", say "restart CodeBuddy".
3. It first asks me **Express** or **Custom** — let me choose.
4. When it finishes, tell me the result in plain words. If it fails, translate the error and stop.

## Step 4 — The menu-bar pet (Siltpoke + Mac only)

If setup already offered the menu-bar pet and I answered, skip this step. Otherwise explain it in two sentences and ask if I want it:

- **The menu-bar pet** sits in the Mac's top menu bar and shows **all your sessions at once** — every project, and every coding tool Siltpoke watches. You see it all the time, even with every terminal closed. The number next to it is how many sessions have a recent review (not a count of problems). Click it for a list: one line per session (project · branch · time · which coding tool wrote the code) with its latest review, plus "Open dashboard" and "Restart daemon". It refreshes once a minute.
- The difference from the **terminal pet** (the bottom line of Claude Code): that one shows only the current session and changes after every turn.

If I say yes:
1. It needs the free app SwiftBar. Check with `ls /Applications/SwiftBar.app`. If it is missing, ask me: install with `brew install --cask swiftbar` (only if `brew --version` works), or let me download it from https://github.com/swiftbar/SwiftBar. Then open it once: `open -a SwiftBar` (the first time, it asks me to pick a plugin folder — accept the default).
2. Run `bun "PLUGIN_ROOT/dist/siltpoke-cli.js" menubar install`, then `… menubar status`, and tell me in one sentence what it said.

## Step 5 — PLC needs no global setup (skip if I did not pick it)

Tell me: PLC is set up **per project**, not once for the whole machine. Inside a project I either type `/init-harness` (if CodeBuddy shows it) or say "set up this project with project-lifecycle". It looks at the code, writes a few project files, and asks before overwriting anything. Do **not** do it now.

## Step 6 — The one thing I must do myself

Tell me clearly: **run `/reload-plugins` in CodeBuddy, or quit and start it again, now.** The plugins and the review hook only load then. Then ask me to type `/siltpoke-` and tell you whether commands show up — that decides which column of Step 7 I use.

## Step 7 — Getting started: my first day

Before I reload, print this walkthrough in my language, only the parts for what I installed, filled with my real results. Make it a numbered list. For each step give both forms — **the slash command** (if CodeBuddy shows `/siltpoke-…` commands) **or the sentence to say**. Do not invent features that are not listed here.

**Siltpoke — first 10 minutes**
1. `/siltpoke-doctor` or "check my Siltpoke install". You get a ✓/✗ checklist. All ✓ means it works. If something is ✗, it says what to do.
2. Ask CodeBuddy for any small real change (for example: "add a comment explaining this function"). When it finishes, Siltpoke reviews the change in the background. You do not need to do anything.
3. On a Mac with the menu-bar pet, the menu bar shows the new review within a minute.
4. `/siltpoke-last` or "show me the latest Siltpoke review".
5. `/siltpoke-dashboard` or "open the Siltpoke dashboard". It opens http://127.0.0.1:9876 — review history, chat with your pet about your code, what it remembers, and the Code Map. On a review, press **ACK** (seen, useful) or **DISMISS** (wrong). This is how it learns what to stop saying.
6. Need quiet? `/siltpoke-mute 1h` or "mute Siltpoke for 1 hour"; `/siltpoke-unmute` or "unmute Siltpoke" to undo.

**PLC — your first project**
1. Inside a project: `/init-harness` or "set up this project with project-lifecycle". Answer its questions.
2. Talk about the code first, no edits: "explain how this project is structured."
3. Build one small feature: `/ship <what you want>` or "use project-lifecycle to ship <what you want>". It stops to check with you at the user story, the spec, and the pull request.
4. Stopping for the day? `/handoff` or "hand off — save where we are to RESUME.md".
5. Next time: `/catchup` or "catch me up from RESUME.md".

**Both together — a normal day:** catch up → build → Siltpoke reviews each turn in the background → read the latest review when you want → hand off.

## Step 8 — Keep using it

Print this right after the first-day walkthrough, in my language, only the parts for what I installed. It is how I use the plugins every day after the first one.

**Siltpoke, every day**
1. Just work. Siltpoke reviews each turn by itself — you never have to start it.
2. When the pet looks worried (or the menu-bar number goes up), read the review: `/siltpoke-last` or "show me the latest Siltpoke review".
3. Teach it. In the dashboard (`/siltpoke-dashboard` or "open the Siltpoke dashboard"), press **DISMISS** on a review that is wrong and **ACK** on one that helped. It remembers, and over time stops repeating what you dismissed.
4. Once a week, look at the dashboard's Memory page — that is what it has learned about your code.
5. Reviews went quiet? `/siltpoke-doctor` or "check my Siltpoke install" first; if everything is ✓, `/siltpoke-wake` or "wake Siltpoke".
6. Busy (a demo, pairing)? `/siltpoke-mute 1h` or "mute Siltpoke for 1 hour" — it turns itself back on when the time is up.

**PLC, every session**
1. Start: `/catchup` or "catch me up from RESUME.md" — where you left off, what shipped, what is next.
2. New feature: `/ship <what you want>` or "use project-lifecycle to ship <what you want>".
3. A design question you are not sure about: `/research <question>` or "research <question> with project-lifecycle" — it comes back with cited sources.
4. Before merging a branch: `/review` or "review this branch with project-lifecycle".
5. End: `/handoff` or "hand off — save where we are to RESUME.md". The next session starts again at item 1.
6. Ready to publish a version: `/release` or "cut a release with project-lifecycle".

**Keep it current:** inside CodeBuddy, `/plugin marketplace update siltpoke` and `/plugin marketplace update project-life-cycle`, then `/reload-plugins`.

## Step 9 — The manual

End with this, in my language, only the rows for what I installed:

| | Status |
|---|---|
| Project Life Cycle | installed — version |
| Siltpoke | installed — version, pet name + species |
| Bun | version (and its path) |
| Menu-bar pet | installed / not installed / not a Mac |
| Slash commands in CodeBuddy | yes / no (from Step 6) |
| **Still to do** | reload → check the Siltpoke install · set up a project with PLC |

Cost: the review runs a separate model call through a CLI you are already logged into — no extra account. Reviews are saved on your machine; nothing is sent anywhere except the normal model call and a once-a-day check with GitHub for the latest version number — that check sends nothing about you or your code, and Siltpoke receives nothing. Turn it off with `"updateCheck": {"enabled": false}` in `~/.siltpoke/config.json`.

Want the other plugin later? Paste this same prompt again — it only adds what is missing.
