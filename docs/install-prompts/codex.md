You are installing Codex plugins for me, setting them up, and then teaching me to use them. Talk to me in the language I am writing in. Keep each message short. **Ask me before anything that downloads and runs a script, installs an app, clones a repo, or changes my shell profile or config files.**

There are two plugins. They are independent — I can have one, the other, or both:
- **Siltpoke** — a second reviewer that watches my coding sessions. After each turn, a *separate* AI process reads what changed and writes down what it thinks was missed. It remembers bugs across sessions, and it has a dashboard and a small pet. Repo: https://github.com/Siltpoke/siltpoke
- **Project Life Cycle (PLC)** — a working method for AI coding: spec → plan → build → verify → ship → release. Repo: https://github.com/Siltpoke/project-life-cycle

**Important for Codex:** neither plugin has slash commands here. Everything is done by asking you in plain words, and you use their skills. Tell me this once, early.

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

Run `codex plugin list` first. Then:
- If one of them is already installed, say so in one line ("you already have PLC — this time I'll only add Siltpoke") and skip its install.
- For anything not installed yet, ask me once: **both / only Siltpoke / only PLC**. Recommend "both" in one sentence, but do what I pick. Every later step applies only to what I picked.

## Step 1 — Check the tools

Run these and tell me in one line each what you found:
- `codex --version`, `git --version`, `uname -s` (a Mac? only matters for the menu-bar pet in Step 4)
- Siltpoke only: `bun --version`. Siltpoke's reviewer runs on Bun. If it is missing, **ask me first**, then run `curl -fsSL https://bun.sh/install | bash` and check again with `~/.bun/bin/bun --version` (my shell will not see the new PATH until it restarts — that is fine, setup records the full path).

## Step 2 — Install

Run one line at a time. If any line fails, stop and show me the exact error.

**Siltpoke:**
```bash
codex plugin marketplace add https://github.com/Siltpoke/siltpoke
codex plugin add siltpoke@siltpoke
```
The `@siltpoke` part is required — a bare `codex plugin add siltpoke` fails.

**PLC** installs from a local copy in Codex, so it needs more steps:
1. Ask me, then clone it: `git clone https://github.com/Siltpoke/project-life-cycle ~/plugins/project-lifecycle`
2. Read the section "Codex setup" in `~/plugins/project-lifecycle/README.md` and follow it exactly: it adds one entry to `~/.agents/plugins/marketplace.json`, then runs `codex plugin add project-lifecycle@<marketplace-name>`. If that file already exists, show me the change before you write it. If you cannot tell the marketplace name, show me the file and ask.

Then run `codex plugin list` and confirm each one I picked shows as installed and enabled. Do not claim success from the install output alone. **If Siltpoke is not in that list, stop here and show me the error** — do not go on to Step 3; setup on a plugin that is not installed looks like it worked, but reviews will never run.

## Step 3 — Set up Siltpoke (skip if I did not pick it)

Reviews do not start until a pet exists at `~/.siltpoke/config.json`. If that file already exists, setup was done before: say so, ask if I want to redo it, and skip to Step 4 if not.

The Siltpoke skill does the setup. A new Codex skill may not be loaded until a new thread, so read it from disk instead:
1. Find the installed plugin folder: `ls -d ~/.codex/plugins/cache/siltpoke/siltpoke/*/ | sort -V | tail -1`. Call it `PLUGIN_ROOT`. Only use this folder — Codex also keeps a download copy under `~/.codex/.tmp/`, which is not the installed plugin.
2. Read `PLUGIN_ROOT/skills/siltpoke/SKILL.md` (if not there: `find PLUGIN_ROOT -name SKILL.md -path '*siltpoke*'`).
3. Follow its sections **"Resolve the plugin root first"** and **"Create your pet (first-time setup)"** exactly. It asks me Express or Custom — let me choose.
4. When it finishes, tell me the result in plain words. If it fails, translate the error and stop.

## Step 4 — The menu-bar pet (Siltpoke + Mac only)

On a Mac, the menu bar is the easiest place to see Siltpoke without opening anything. Explain it in two sentences and ask if I want it:

- **The menu-bar pet** sits in the Mac's top menu bar and shows **all your sessions at once** — every project, and every coding tool Siltpoke watches (Codex, and Claude Code if you use it too). You see it all the time, even with every terminal closed. The number next to it is how many sessions have a recent review (not a count of problems). Click it for a list: one line per session (project · branch · time · which coding tool wrote the code) with its latest review, plus "Open dashboard" and "Restart daemon". It refreshes once a minute.
- (If I also use Claude Code: there, Siltpoke also has a **terminal pet** in the bottom line, which shows only that one session and changes after every turn.)

If I say yes:
1. It needs the free app SwiftBar. Check with `ls /Applications/SwiftBar.app`. If it is missing, ask me: install with `brew install --cask swiftbar` (only if `brew --version` works), or let me download it from https://github.com/swiftbar/SwiftBar. Then open it once: `open -a SwiftBar` (the first time, it asks me to pick a plugin folder — accept the default).
2. Run `"$BUN" "$PLUGIN_ROOT/dist/siltpoke-cli.js" menubar install`, then `… menubar status`, and tell me in one sentence what it said.

## Step 5 — PLC needs no global setup (skip if I did not pick it)

Tell me: PLC is set up **per project**, not once for the whole machine. There is no `/init-harness` command in Codex — instead, inside a project I say "set up this project with project-lifecycle", and the skill looks at the code, writes a few project files, and asks before overwriting anything. Do **not** do it now.

## Step 6 — The one thing I must do myself

Tell me clearly: **quit Codex and start it again (or at least start a new thread) now.** New skills and the review hook only load then.

## Step 7 — Getting started: my first day

Before I restart, print this walkthrough in my language, only the parts for what I installed, filled with my real results. Make it a numbered list I can follow step by step. In Codex everything is said in plain words — give me the exact sentence to say. Do not invent features that are not listed here.

**Siltpoke — first 10 minutes**
1. Say: "check my Siltpoke install". You get a ✓/✗ checklist. All ✓ means it works. If something is ✗, it says what to do.
2. Ask Codex for any small real change (for example: "add a comment explaining this function"). When Codex finishes, Siltpoke reviews the change in the background. You do not need to do anything.
3. On a Mac with the menu-bar pet, the menu bar shows the new review within a minute.
4. Say: "show me the latest Siltpoke review".
5. Say: "open the Siltpoke dashboard". It opens http://127.0.0.1:9876 — review history, chat with your pet about your code, what it remembers, and the Code Map. On a review, press **ACK** (seen, useful) or **DISMISS** (wrong). This is how it learns what to stop saying.
6. Need quiet? Say "mute Siltpoke for 1 hour", and "unmute Siltpoke" to undo.

**PLC — your first project**
1. Inside a project, say: "set up this project with project-lifecycle". Answer its questions.
2. Talk about the code first, no edits: "explain how this project is structured."
3. Build one small feature: "use project-lifecycle to ship <what you want>". It stops to check with you at the user story, the spec, and the pull request.
4. Stopping for the day? Say "hand off — save where we are to RESUME.md".
5. Next time, say "catch me up from RESUME.md".

**Both together — a normal day**
1. Open a project → "catch me up"
2. Build with project-lifecycle, or just work normally
3. Siltpoke reviews each turn in the background → "show me the latest Siltpoke review"
4. Leaving → "hand off"

## Step 8 — Keep using it

Print this right after the first-day walkthrough, in my language, only the parts for what I installed. It is how I use the plugins every day after the first one.

**Siltpoke, every day**
1. Just work. Siltpoke reviews each turn by itself — you never have to start it.
2. When the pet looks worried (or the menu-bar number goes up), read the review: say "show me the latest Siltpoke review".
3. Teach it. In the dashboard (say "open the Siltpoke dashboard"), press **DISMISS** on a review that is wrong and **ACK** on one that helped. It remembers, and over time stops repeating what you dismissed.
4. Once a week, look at the dashboard's Memory page — that is what it has learned about your code.
5. Reviews went quiet? say "check my Siltpoke install" first; if everything is ✓, say "wake Siltpoke".
6. Busy (a demo, pairing)? say "mute Siltpoke for 1 hour" — it turns itself back on when the time is up.

**PLC, every session**
1. Start: say "catch me up from RESUME.md" — where you left off, what shipped, what is next.
2. New feature: say "use project-lifecycle to ship <what you want>".
3. A design question you are not sure about: say "research <question> with project-lifecycle" — it comes back with cited sources.
4. Before merging a branch: say "review this branch with project-lifecycle".
5. End: say "hand off — save where we are to RESUME.md". The next session starts again at item 1.
6. Ready to publish a version: say "cut a release with project-lifecycle".

**Keep it current:** PLC: `git -C ~/plugins/project-lifecycle pull`, then the update steps in its README §"Codex setup". Siltpoke: the Codex section of https://github.com/Siltpoke/siltpoke#codex. Then restart Codex.

## Step 9 — The manual

End with this, in my language, only the rows for what I installed:

| | Status |
|---|---|
| Project Life Cycle | installed — version from `codex plugin list` |
| Siltpoke | installed — version, pet name + species |
| Bun | version (and its path) |
| Menu-bar pet | installed / not installed / not a Mac |
| **Still to do** | restart Codex → "check my Siltpoke install" (Siltpoke) · "set up this project with project-lifecycle" (PLC) |

Siltpoke, things to say: check my install · show the latest review · open the dashboard · mute for <time> / unmute · menu-bar pet install / status / remove · show the Siltpoke manual. Not available in a plugin install (they need a source clone): listing or dismissing reviews from the chat, `remember`, and indexing a repo for the Code Map from the chat — use the dashboard for reviews.

Cost: the review runs a separate model call through a CLI you are already logged into — no extra account. Reviews are saved on your machine; nothing is sent anywhere except the normal model call and a once-a-day check with GitHub for the latest version number — that check sends nothing about you or your code, and Siltpoke receives nothing. Turn it off with `"updateCheck": {"enabled": false}` in `~/.siltpoke/config.json`.

Want the other plugin later? Paste this same prompt again — it only adds what is missing.
