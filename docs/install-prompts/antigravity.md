You are installing Antigravity (agy) plugins for me, setting them up, and then teaching me to use them. Talk to me in the language I am writing in. Keep each message short. **Ask me before anything that downloads and runs a script, installs an app, clones a repo, or changes my shell profile or config files.**

There are two plugins. They are independent — I can have one, the other, or both:
- **Siltpoke** — a second reviewer that watches my coding sessions. After each turn, a *separate* AI process reads what changed and writes down what it thinks was missed. It remembers bugs across sessions, and it has a dashboard and a small pet. Repo: https://github.com/Siltpoke/siltpoke
- **Project Life Cycle (PLC)** — a working method for AI coding: spec → plan → build → verify → ship → release. Repo: https://github.com/Siltpoke/project-life-cycle

**Important for agy:** neither plugin has slash commands here. Everything is done by asking you in plain words, and you use their skills. Tell me this once, early.

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

Run `agy plugin list` first. Then:
- If one of them is already installed, say so in one line ("you already have PLC — this time I'll only add Siltpoke") and skip its install.
- For anything not installed yet, ask me once: **both / only Siltpoke / only PLC**. Recommend "both" in one sentence, but do what I pick. Every later step applies only to what I picked.

## Step 1 — Check the tools

Run these and tell me in one line each what you found:
- `agy --version`, `git --version`, `uname -s` (a Mac? only matters for the menu-bar pet in Step 4)
- Siltpoke only: `bun --version`. Siltpoke needs Bun both to build and to review. If it is missing, **ask me first**, then run `curl -fsSL https://bun.sh/install | bash` and use `~/.bun/bin/bun` for the rest of this session (my shell will not see the new PATH until it restarts — that is fine, setup records the full path).

## Step 2 — Install

Run one line at a time. If any line fails, stop and show me the exact error.

**Siltpoke** — agy must install the `.antigravity-plugin` folder from a local copy. **Never** run `agy plugin install https://github.com/Siltpoke/siltpoke` and never install the repo's top folder: agy then registers it as a Claude Code plugin and reviews silently never run.
```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke && bun install
cd ~/siltpoke && bun run build:dist
agy plugin install ~/siltpoke/.antigravity-plugin
agy plugin validate ~/siltpoke/.antigravity-plugin
```
If `~/siltpoke` already exists, ask me before touching it (it may be my own copy); if it is a clean clone of this repo, `git -C ~/siltpoke pull` instead of cloning.

**PLC:**
```bash
git clone https://github.com/Siltpoke/project-life-cycle.git ~/plugins/project-life-cycle
agy plugin install ~/plugins/project-life-cycle
```

Then run `agy plugin list` and confirm each one I picked shows as installed. Do not claim success from the install output alone.

## Step 3 — Set up Siltpoke (skip if I did not pick it)

Reviews do not start until a pet exists at `~/.siltpoke/config.json` — until then, the plugin is installed but does nothing. If that file already exists, setup was done before: say so, ask if I want to redo it, and skip to Step 4 if not.

The Siltpoke skill does the setup. Read it from disk so you do not depend on it being loaded yet:
1. `PLUGIN_ROOT` is `~/.gemini/config/plugins/siltpoke` (agy copies the plugin there). Check that `PLUGIN_ROOT/dist/siltpoke-cli.js` exists; if not, use `~/siltpoke/.antigravity-plugin`.
2. Read `PLUGIN_ROOT/skills/siltpoke/SKILL.md`.
3. Follow its sections **"Resolve the plugin root first"** and **"Create your pet (first-time setup)"** exactly. It asks me Express or Custom — let me choose.
4. When it finishes, tell me the result in plain words. If it fails, translate the error and stop.

## Step 4 — The menu-bar pet (Siltpoke + Mac only)

With this install, agy has no terminal pet (statusline) — so on a Mac, the menu bar is the one place you see Siltpoke without opening anything. Explain it in two sentences and ask if I want it:

- **The menu-bar pet** sits in the Mac's top menu bar and shows **all your sessions at once** — every project, and every coding tool Siltpoke watches (agy, and Claude Code or Codex if you use them too). You see it all the time, even with every terminal closed. The number next to it is how many sessions have a recent review (not a count of problems). Click it for a list: one line per session (project · branch · time · which coding tool wrote the code) with its latest review, plus "Open dashboard" and "Restart daemon". It refreshes once a minute.
- (A **terminal pet** — the bottom line of Claude Code — shows only the current session and changes after every turn. agy can show one too, but only with Siltpoke's from-source install, which this prompt does not use.)

If I say yes:
1. It needs the free app SwiftBar. Check with `ls /Applications/SwiftBar.app`. If it is missing, ask me: install with `brew install --cask swiftbar` (only if `brew --version` works), or let me download it from https://github.com/swiftbar/SwiftBar. Then open it once: `open -a SwiftBar` (the first time, it asks me to pick a plugin folder — accept the default).
2. Run `"$BUN" "$PLUGIN_ROOT/dist/siltpoke-cli.js" menubar install`, then `… menubar status`, and tell me in one sentence what it said.

## Step 5 — PLC needs no global setup (skip if I did not pick it)

Tell me: PLC is set up **per project**, not once for the whole machine. There is no `/init-harness` command in agy — instead, inside a project I say "set up this project with project-lifecycle", and the skill looks at the code, writes a few project files, and asks before overwriting anything. Do **not** do it now.

## Step 6 — The one thing I must do myself

Tell me clearly: **quit agy and start it again now.** New skills and the review hook only load then.

One limit to mention: reviews do not run in headless `agy -p` mode with this install — only in normal interactive sessions.

## Step 7 — Getting started: my first day

Before I restart, print this walkthrough in my language, only the parts for what I installed, filled with my real results. Make it a numbered list I can follow step by step. In agy everything is said in plain words — give me the exact sentence to say. Do not invent features that are not listed here.

**Siltpoke — first 10 minutes**
1. Say: "check my Siltpoke install". You get a ✓/✗ checklist. All ✓ means it works. If something is ✗, it says what to do.
2. Ask agy for any small real change (for example: "add a comment explaining this function"). When agy finishes, Siltpoke reviews the change in the background — agy does not wait for it.
3. On a Mac with the menu-bar pet, the menu bar shows the new review within a minute.
4. Say: "show me the latest Siltpoke review".
5. Say: "open the Siltpoke dashboard". It opens http://127.0.0.1:9876 — review history, chat with your pet about your code, what it remembers, and the Code Map. On a review, press **ACK** (seen, useful) or **DISMISS** (wrong). This is how it learns what to stop saying.
6. Need quiet? Say "mute Siltpoke for 1 hour", and "unmute Siltpoke" to undo.

Good to know: if you pick a Claude model inside agy, the reviewer is also Claude — Claude reviewing Claude, so it can share the same blind spots.

**PLC — your first project**
1. Inside a project, say: "set up this project with project-lifecycle". Answer its questions.
2. Talk about the code first, no edits: "explain how this project is structured."
3. Build one small feature: "use project-lifecycle to ship <what you want>". It stops to check with you at the user story, the spec, and the pull request.
4. Stopping for the day? Say "hand off — save where we are to RESUME.md".
5. Next time, say "catch me up from RESUME.md".

**Both together — a normal day:** catch me up → build → Siltpoke reviews each turn in the background → "show me the latest Siltpoke review" → hand off.

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

**Keep it current:** `git -C ~/siltpoke pull && cd ~/siltpoke && bun install && bun run build:dist && agy plugin install ~/siltpoke/.antigravity-plugin` · PLC: `git -C ~/plugins/project-life-cycle pull && agy plugin install ~/plugins/project-life-cycle`. Then restart agy.

## Step 9 — The manual

End with this, in my language, only the rows for what I installed:

| | Status |
|---|---|
| Project Life Cycle | installed — version from `agy plugin list` |
| Siltpoke | installed — version, pet name + species |
| Bun | version (and its path) |
| Menu-bar pet | installed / not installed / not a Mac |
| **Still to do** | restart agy → "check my Siltpoke install" (Siltpoke) · "set up this project with project-lifecycle" (PLC) |

Siltpoke, things to say: check my install · show the latest review · open the dashboard · mute for <time> / unmute · menu-bar pet install / status / remove · show the Siltpoke manual. Not available in a plugin install (they need Siltpoke's source scripts): listing or dismissing reviews from the chat, `remember`, and indexing a repo for the Code Map from the chat — use the dashboard for reviews.

Cost: the review runs a separate model call through a CLI you are already logged into — no extra account. Reviews are saved on your machine; nothing is sent anywhere except the normal model call and a once-a-day check with GitHub for the latest version number — that check sends nothing about you or your code, and Siltpoke receives nothing. Turn it off with `"updateCheck": {"enabled": false}` in `~/.siltpoke/config.json`.

Want the other plugin later? Paste this same prompt again — it only adds what is missing.
