# Siltpoke — User Manual

> Daily-use reference. For setup, see [`README.md`](../README.md). This file
> is mirrored by the `/siltpoke:siltpoke-help` slash command — keep them in sync.

---

## What Siltpoke does

A separate `claude -p` subprocess reads over your coding agent's work after
each supported turn, finds bugs the writing-side agent missed, and writes a
review to disk.
**Reviews never auto-inject into your chat** — you pull them in
explicitly when you want them.

---

## Daily loop in Claude Code (the 3 commands you'll actually use)

```
/siltpoke-inbox            List pending reviews (read-only)
/siltpoke-forward <id>     Pull a specific review into the chat (+10 XP if fresh)
(no dismiss command ships today — see the note under "Reviewing")
```

That's the whole loop:

1. Claude finishes a turn → Siltpoke runs in background → review lands in inbox.
2. You run `/siltpoke-inbox` whenever you want.
3. For each pending review:
   - **Useful** → `/siltpoke-forward <id>` (default — XP awarded)
   - **Wrong** → dismiss it in the dashboard. Today that RECORDS the dismissal and nothing more: there is no `/siltpoke-dismiss` command, and the code that would turn a dismissal into a learned rule is not wired to anything. Siltpoke does learn, but from the other direction — when you actually fix code it flagged, confirmed mechanically by git.
   - **Neutral / already-seen** → `/siltpoke-ack <id>` (no XP, no learning)

---

## Daily loop in Codex

**Plugin-native install (recommended):**

```bash
codex plugin marketplace add https://github.com/Siltpoke/siltpoke
codex plugin add siltpoke@siltpoke
codex plugin list                                      # verify: siltpoke … installed, enabled
```

The **`@siltpoke` marketplace qualifier is required** — a bare `codex plugin add siltpoke` fails with `plugin requires --marketplace unless passed as <plugin>@<marketplace>`.

This installs Siltpoke with reviews included — the review hooks ride the plugin (no source clone needed).

**From source (alternative):**

If you prefer to install from a cloned repo:

```bash
codex plugin marketplace add ~/path/to/siltpoke-repo
codex plugin list                                     # verify: siltpoke … installed, enabled
```

Then use natural language instead of Siltpoke slash commands:

```
open the Siltpoke dashboard
show my Siltpoke inbox
show Siltpoke memory
run Siltpoke setup
```

Current boundary: Codex does not expose Siltpoke as custom top-level
`/siltpoke-*` slash commands, and `/prompts:siltpoke-dashboard` is not the
supported route. The stable Codex surface is the installed Siltpoke
plugin/skill plus the Codex `Stop` and `SessionStart` hooks.

---

## Daily loop in CodeBuddy / Qoder

Both are Claude Code forks — they reuse the existing `.claude-plugin/`
(auto-discover `hooks/hooks.json`, expand `${CLAUDE_PLUGIN_ROOT}`), so
plugin-native install works the same way as Claude Code and Codex.

**Plugin-native install (recommended):**

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
Review runs plugin-native — no source clone needed.

**From source (fallback):**

```bash
git clone https://github.com/Siltpoke/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run setup --agent codebuddy,qoder
```

Then use natural language instead of Siltpoke slash commands — neither
CodeBuddy nor Qoder expose custom top-level `/siltpoke-*` slash commands:

```
open the Siltpoke dashboard
show my Siltpoke inbox
show Siltpoke memory
run Siltpoke setup
```

---

## Full slash-command reference

These commands are for Claude Code. In Codex, ask for the same workflow in
plain language through the Siltpoke skill/plugin.

| Command | What it does |
|---|---|
| `/siltpoke:siltpoke-setup` | Create your pet + finish the install (statusline, dashboard) |
| `/siltpoke:siltpoke-last` | Pull Siltpoke's most recent review INTO this conversation |
| `/siltpoke:siltpoke-dashboard` | Open the dashboard (http://127.0.0.1:9876) |
| `/siltpoke:siltpoke-restart-daemon` | Restart the dashboard daemon |
| `/siltpoke:siltpoke-menubar` | Put the pet in your macOS menu bar (needs SwiftBar). install/status/remove |
| `/siltpoke:siltpoke-mute` | Silence Siltpoke for a duration (15m / 1h / 2d / indefinite) |
| `/siltpoke:siltpoke-unmute` | Un-silence Siltpoke |
| `/siltpoke:siltpoke-brain` | Show or set which CLI + model reviews your code (set review <family> [model]) |
| `/siltpoke:siltpoke-doctor` | Install-health diagnostic (✓/✗ checklist) |
| `/siltpoke:siltpoke-wake` | Reviews went quiet? Clear the stuck breaker and review the next turn |
| `/siltpoke:siltpoke-uninstall` | Show what setup changed (status line, dashboard, menu bar), then remove each group you say yes to — before removing the plugin |
| `/siltpoke:siltpoke-help` | This manual |

That is the whole surface. Everything else — review history, chat, memory,
timeline, code map, XP and spend — lives in the dashboard, not behind a slash
command. This table used to list `/siltpoke`, `/siltpoke-inbox`,
`/siltpoke-forward`, `/siltpoke-forward-all`, `/siltpoke-ack`,
`/siltpoke-dismiss`, `/siltpoke-stats`, `/siltpoke-pet` and a
`/siltpoke-review` alias; those were culled from the plugin (their `src/cli`
code remains) and naming a command that does not exist is the same defect
`/siltpoke:siltpoke-wake` was shipped to fix.

### Dashboard (browser)

```bash
bun run report          # ensures the daemon is up, opens http://127.0.0.1:9876/
```

The dashboard is served live by the daemon (`siltpoked`), not written to a
static file. `bun run report` lazy-spawns the daemon if it isn't already
running, then opens `http://127.0.0.1:9876/` in your default browser; pass
`--no-open` to skip launching the browser. Refresh by reloading the page.
Sections: pet header, today's metrics, 7-day bar chart, per-project table,
pending-review inbox grouped by project, last 30 brain calls, recent
verdicts.

**Settings → Agents** (`/settings`) shows the coding agents on this machine
(building, with when Siltpoke last saw a session; installed; not installed)
and Siltpoke's own three agents — Chat, Critic, Summarizer. Each row says
which agent and model it uses and why, what its last recorded call was, its
daily cap (saved when you leave the field) with today's count, and **Change
model**, which lists every agent's models as that agent's command reports
them, sorted by models.dev's price from the model's maker. The prices only
sort the list; they are not what your plan charges.

---

## Daemon autostart (opt-in)

The daemon is **optional**. Core review runs entirely inside the Stop
hook — the daemon only powers the web surfaces (dashboard, floating
chat, repo-index). So `bun run setup` asks "开机自启 siltpoke daemon？"
and defaults to **no**: nothing extra installed, and no `ECONNREFUSED`
on reboot from a hook reaching for a server that isn't there.

Turn it on whenever you want the dashboard — just open it:

```bash
/siltpoke:siltpoke-dashboard    # starts the daemon and enables it so it stays up
```

That flips `daemon.enabled` on in `~/.siltpoke/config.json`, so the
Stop hook keeps the daemon alive from then on. To also survive reboots,
install autostart:

- macOS: a LaunchAgent at `~/Library/LaunchAgents/io.siltpoke.daemon.plist`
  (`RunAtLoad` + `KeepAlive` — relaunches if it crashes).
- Linux: a systemd user unit `siltpoked.service` (`Restart=always`).
- Windows: nothing — the install step is skipped, so the dashboard does not
  survive a reboot and you start it yourself with `/siltpoke:siltpoke-dashboard`.
  Reviews are registered separately, so autostart has no bearing on them. On
  Windows the review hook is registered again, but the whole path has not been
  confirmed on a Windows machine yet. What is known: the reviewer runs through
  a `.cmd` shim and the runtime refuses to hand a `.cmd` an argument containing
  characters it would re-interpret — which the review prompt always contains.
  That was measured there on 2026-09-24, and the fix for it was run on its own
  there on 2026-09-25. Neither the fix reached through the hook, nor the
  re-registration itself, has been exercised on Windows. All five reviewer CLIs
  now hand the prompt over some other way, but only `claude`'s route has been
  tried on a Windows machine; the other four are implemented and untested there.
  `/siltpoke:siltpoke-doctor`'s **review hook can start** row says whether the hook
  itself can start on this machine — it does not promise the review succeeds.

Install/refresh any time: `bun src/cli/daemon.ts install-autostart`.
`bun run uninstall` removes it along with everything else.

Two caveats:

- **The plist/unit hardcodes this repo's path.** If you move the repo,
  re-run `install-autostart` to repair it.
- **Daemon off = a sleeping pet, never a red error.** With the daemon
  disabled (the default) the Stop hook does not respawn it — reviews,
  the statusline pet, and the menu-bar pet all keep working without it.
  `/siltpoke:siltpoke-doctor` reads a stopped daemon as a normal info row, and
  only flags it when you've enabled it but it's unreachable.

---

## Menu-bar pet (SwiftBar)

macOS only. Where the dashboard and chat are per-project, the
menu-bar pet is **machine-global** — one [SwiftBar](https://github.com/swiftbar/SwiftBar)
menu-bar icon aggregating pending reviews across *every* active
Siltpoke session on the machine, so you don't have to tab through
each project's inbox to notice a review landed.

Install it either from the setup wizard (`bun run setup` asks "Add
the menu-bar pet?" right after the autostart question) or any time
after the fact:

```bash
/siltpoke:siltpoke-menubar install   # or: bun src/cli/menubar.ts install
```

Consent-driven, same as autostart: it asks before installing SwiftBar
via Homebrew (skipped if SwiftBar's already there) and before writing
the plugin shim (`~/Library/Application Support/SwiftBar/plugins/siltpoke.1m.sh`).
Declining at any step installs/writes nothing.

Once running, the menu-bar title is the total pending-review count;
opening it lists read-only cards, newest first, each tagged
`repo · branch · #session` so you know at a glance which project and
branch a review came from, with a link into the dashboard Timeline
for the full detail. Menu-bar notifications go through the same
gates as everything else — `/siltpoke:siltpoke-mute` and quiet-hours suppress
them exactly like chat-surfaced reviews.

`/siltpoke:siltpoke-menubar status` reports whether the pet is actually showing —
the shim being installed is necessary but not sufficient, since SwiftBar
is what draws the menu bar. It names the one thing that is missing: the
shim, SwiftBar itself, a running SwiftBar, or a shim sitting in a folder
SwiftBar is no longer reading.
`/siltpoke:siltpoke-menubar remove` deletes the shim (running the command is the
consent — no extra prompt, matching `/siltpoke:siltpoke-mute` /
`/siltpoke:siltpoke-unmute`).

---

## Review unit

Controls *when* Siltpoke actually runs Brain — by **unit of work**, not by
which editor event fired:

| Unit | Behavior |
|---|---|
| `commit` (default) | Reviews when a commit closes: HEAD moved and the tree changed with it |
| `pr` | Reviews the whole branch against its base, not one commit at a time |

Change in `~/.siltpoke/config.json`:

```json
{
  "reviewUnit": "pr"
}
```

Siltpoke stays quiet when nothing closed — no new commit, or a commit whose
tree is identical to the last reviewed one (an amend, a rebase that changed
nothing). A turn that touched only prose is skipped too; a file under
`prompts/`, or any `*.prompt.md`, counts as code.

> **Replaces `triggerMode`.** The old key had four values — `always`, `gates`,
> `on_demand`, `hybrid` — and asked "is this hook event one I was configured
> for". Measured over 35,184 real triggers it blocked **2**. A config still
> carrying any of those four values loads without error and behaves as
> `commit`, and the old key is never rewritten, so downgrading finds your
> setting intact.

---

## Reviewer Brain provider (cross-family review)

By default the critic's Brain is `claude -p`. You can point it at a **different
model family** — the reviewer then doesn't share the blind spots of the agent
that wrote the code:

```json
{
  "reviewer_provider": "codex"
}
```

Values: `"claude"` (default) | `"codex"` (OpenAI Codex CLI must be installed
and logged in) | `"agy"` (Antigravity CLI must be installed and logged in) |
`"qoder"` (Qoder CLI must be installed and logged in) | `"codebuddy"`
(CodeBuddy CLI must be installed and logged in).
`SILTPOKE_REVIEWER_PROVIDER` env var overrides the config for one-off
tests/smoke — `/siltpoke:siltpoke-doctor` shows the effective value and marks
env overrides.

You can also pick **which model** that reviewer runs with the optional
`reviewer_model` key:

```json
{
  "reviewer_provider": "agy",
  "reviewer_model": "gemini-2.5-pro"
}
```

`reviewer_model` reaches `agy` / `qoder` / `codebuddy` as their `--model` flag
and `codex` as `-m`. Under a ChatGPT login codex accepts only the models it lists
for your account (`codex debug models`); any other is refused, and the review
fails with codex's own message — so when you switch to `codex`, clear or change a
`reviewer_model` left over from another agent. Unset = each provider's own
default (for codex, the `model` in `~/.codex/config.toml`). `/siltpoke:siltpoke-doctor` shows the resolved `model=…` on the reviewer row.

**Scope (allowlist)**: only the per-turn **critic** (and the eval harness)
honor this key. Chat, Code Map explanations, memory extraction, and every other
Brain consumer stay on claude by code — migrating them is tracked separately.

**What to know before switching:**

- **Billing is ChatGPT-plan quota, not dollars.** Codex calls record
  `cost_usd: null` in the ledger (never a fabricated dollar figure); their
  tokens still count against your `dailyTokenLimit`, and separate
  **daily call caps** brake runaway quota use. There is one cap per role —
  Critic (reviews), Chat (dashboard chat and its recap) and Summarizer
  (summaries and memory) — 50 calls a day each by default, and each counts
  that role's calls whichever agent makes them: all five agents, Claude Code
  included, are counted and stopped the same way. Switching agent does not
  restart a count. Change the caps on the dashboard's Settings page, or in
  `~/.siltpoke/config.json` with `"brain": { "quota_daily_cap": 100,
  "chat_quota_daily_cap": 100, "extract_quota_daily_cap": 100 }` (`0` = no
  cap; an invalid value keeps 50). The counts restart at the next day boundary
  (`budget.resetAt`); `/siltpoke:siltpoke-wake` does not reset them. Chatting does not
  use up the day's reviews, and reviews do not use up the day's chat.
- **The served model is the one you chose**, else the configured model from
  `~/.codex/config.toml` — siltpoke records that name as provenance (codex's
  output does not report it), and OpenAI may rotate what the name maps to.
- **Review quality is eval-gated.** Codex becomes a *documented-supported*
  default only after passing the release gate
  (an internal release gate); switching
  before that works but logs a one-time warning, and `/siltpoke:siltpoke-doctor`'s
  reviewer row shows whether any eval verdict certifies the provider.
- **No silent fallback.** If codex is configured but missing/broken, the
  review is skipped (fail-soft) and doctor warns — siltpoke never silently
  swaps back to claude, because a same-family review pretending to be
  cross-family would be a lie.
- **Recursion is guarded** — the internal codex call cannot trigger a
  review-of-review (siltpoke's own hooks see an internal marker and stand
  down). Caveat: *third-party* hooks you've configured in your own codex
  setup will still fire inside these internal calls.

**For Antigravity (`agy -p`)**:

- **Billing is Google Code Assist quota, not dollars.** Agy calls record
  `cost_usd: null` in the ledger (never a fabricated dollar figure); their
  tokens still count against your `dailyTokenLimit`, and a separate
  **per-provider call-count cap** brakes runaway quota use.
- **Cross-family honesty is enforced.** If agy is configured to use a
  Claude-family model as its own provider, siltpoke logs a one-time warning
  — using a Claude model as the reviewer when a Claude model wrote the code
  defeats the point of cross-family review. Prefer a different model family
  in agy's configuration.
- **Review quality is uncertified.** Agy becomes a *documented-supported*
  default only after passing the release gate
  (an internal release gate); switching
  before that works but logs a one-time warning, and `/siltpoke:siltpoke-doctor`'s
  reviewer row shows whether any eval verdict certifies the provider.
- **No silent fallback.** If agy is configured but missing/broken, the
  review is skipped (fail-soft) and doctor warns — siltpoke never silently
  swaps back to claude, because a same-family review pretending to be
  cross-family would be a lie.

**For Qoder (`qodercli -p`)**:

- **Billing is Alibaba/Qwen plan quota, not dollars.** Qoder calls record
  `cost_usd: null` in the ledger (never a fabricated dollar figure); their
  tokens still count against your `dailyTokenLimit`, and a separate
  **per-provider call-count cap** brakes runaway quota use.
- **The served model is configured, not attested.** siltpoke records the
  configured model from qoder's own config as provenance, the same
  caveat as codex and agy — there's no way to independently confirm
  what actually served the request.
- **Review quality is uncertified.** Qoder becomes a *documented-supported*
  default only after passing the release gate
  (an internal release gate); switching
  before that works but logs a one-time warning, and `/siltpoke:siltpoke-doctor`'s
  reviewer row shows whether any eval verdict certifies the provider.
- **No silent fallback.** If qodercli is configured but missing/broken, the
  review is skipped (fail-soft) and doctor warns — siltpoke never silently
  swaps back to claude, because a same-family review pretending to be
  cross-family would be a lie.

**For CodeBuddy (`codebuddy -p`)**:

- **Billing is Tencent plan quota, not dollars.** CodeBuddy calls record
  `cost_usd: null` in the ledger (never a fabricated dollar figure); their
  tokens still count against your `dailyTokenLimit`, and a separate
  **per-provider call-count cap** brakes runaway quota use.
- **The served model is configured, not attested.** siltpoke records the
  configured model from codebuddy's own config as provenance, the same
  caveat as codex, agy, and qoder — there's no way to independently confirm
  what actually served the request.
- **Review quality is uncertified.** CodeBuddy becomes a *documented-supported*
  default only after passing the release gate
  (an internal release gate); switching
  before that works but logs a one-time warning, and `/siltpoke:siltpoke-doctor`'s
  reviewer row shows whether any eval verdict certifies the provider.
- **No silent fallback.** If codebuddy is configured but missing/broken, the
  review is skipped (fail-soft) and doctor warns — siltpoke never silently
  swaps back to claude, because a same-family review pretending to be
  cross-family would be a lie.
- **Built against the shared CC-fork envelope shape, live-credit smoke
  pending.** CodeBuddy's implementation reuses the same claude-shaped single
  envelope parse that qoder's real fixture already proved — but the account
  used to author this provider was out of credits (429 "Credits exhausted"),
  so there is no real-output fixture or live smoke test for codebuddy yet.
  It works against the proven shape, not against a confirmed real reply.

---

## Cost control

Default `~$0.04–$0.10/day` thanks to prompt caching (~70k tokens cached,
calls 2+ cost ~$0.001).

```json
{
  "reviewUnit": "pr",
  "budget": { "dailyTokenLimit": 100000 },
  "quietHours": { "start": "23:00", "end": "08:00" }
}
```

- **Budget hard-stop** → pet flips to `sleeping_broke`, Brain skipped until midnight reset
- **Quiet hours** → Brain muted overnight
- **`dailyTokenLimit: 0`** → disables the budget gate entirely
- **Skip-on-no-change** → sha256 over `(session+cwd+changed_files+user_msg)`; identical context never re-runs Brain

---

## Pet / progression system

XP sources:

- `/siltpoke-forward <id>` on a fresh review → **+10 XP**
- `/siltpoke-pet` → **+5 XP** (shared 100 action-XP/day cap with dashboard actions)
- Brain's own `xp_earned_events` for sustained engagement

`xp_to_next_level` scales in bands: `100 × level` (L1–5), `250 × level`
(L6–10), `500 × level` (L11–20), `1000 × level` (L21+). Unlocks:

| Level | Unlock |
|---|---|
| L2 | Pose `peek` + title `Watcher` |
| L3 | Pose `blink` |
| L5 | Title `Apprentice` |
| L10 | Title `Sentinel` |

XP never decreases. Wrong reviews are handled via dismiss/Reflexion,
not by punishing the pet.

The statusline shows `L{level} {xp}/{xp_to_next_level}` under the
pet's name so you can track progress at a glance. Hidden in
`minimalMode` since that mode drops the face entirely.

---

## Personality

Each Siltpoke has 5 dials (0–10):

```json
{
  "snark": 7,         // 0 = sweet, 10 = savage
  "patience": 4,      // 0 = trigger-happy, 10 = saintly
  "rigor": 6,         // 0 = vibes-based, 10 = methodical / cites file:line
  "chattiness": 5,    // 0 = terse, 10 = verbose bubbles
  "curiosity": 8      // 0 = by-the-book, 10 = suggests alternatives
}
```

Re-roll without reinstalling:

```bash
bun run edit-personality
```

Loads current values as defaults — Enter to keep, type new value to
change, or pick a different generation method (`quiz` / `random` /
`memory`).

---

## Match modes

Controls whether the pet mirrors or fills in your traits:

| Mode | Behavior |
|---|---|
| `mirror` (default) | Pet mirrors user. Snarky user → snarky pet. |
| `complement` | Pet inverts user. Lazy user → rigorous pet. |
| `hybrid` | Vibe dials mirror (relatable), task dials complement (fills gaps). |

Set during quiz, or change manually in `config.json` (advanced).

---

## Output language

```json
{
  "language": "zh-CN"
}
```

Supported: `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, plus
anything `claude -p` can reply in. The bubble + review are written
in this language; only code identifiers, file paths, and schema enum
tokens stay English.

If you see English leaking into the bubble for non-English settings,
verify your `language` field is set and restart Claude Code.

---

## Update check

Once a day, at the start of a session, Siltpoke asks GitHub for the version
number of its own latest release. If that is newer than what you have, the next
session says so in one line and names the command to update. It never updates
anything by itself, and it never blocks a session: the session reads a cached
answer and refreshes in the background, so being offline just means the line
does not appear.

That request is the **only** one Siltpoke makes on its own. It carries nothing
about you, your code, or your usage, and Siltpoke receives nothing — the request
goes to GitHub, which sees it the way it would if you opened the releases page
yourself.

It is on by default, because the people it exists for are the ones who do not
know an update is waiting. Turn it off with:

```json
{ "updateCheck": { "enabled": false } }
```

in `~/.siltpoke/config.json`. `/siltpoke:siltpoke-doctor` has a row showing whether it is
on and what the last check found. The cached answer lives in
`~/.siltpoke/update-check.json`; deleting it just forces a fresh check.

## Files Siltpoke owns

Reviews and learned-rule memory are **per-project** — Siltpoke
shouldn't carry review context from one codebase into another.
Pet progression, budget, and debugging logs stay global.

```
~/.siltpoke/                  # global (one pet, one budget)
  config.json                 # personality + budget + trigger
  inner.txt                   # your original statusline command
  progression.json            # XP, level, unlocks
  state.json                  # latest Brain output (fallback when no project)
  usage-events.jsonl          # spend log
  brain-calls.jsonl           # every Brain call (debugging)
  feedback-archive.jsonl      # permanent dismiss/forward archive across projects

{project}/.siltpoke/          # per-project (one folder per repo)
  state.json                  # this project's latest Brain output
  recent_feedback.jsonl       # tier 2: per-project FIFO of last 20 verdicts
  memory.json                 # tier 1: learned rules scoped to this project
  critiques/
    latest.md
    history.jsonl
    archive/YYYY-MM-DD/*
```

The source-only review commands (`/siltpoke-inbox`, `/siltpoke-forward <id>`,
`/siltpoke-ack <id>`, `/siltpoke-dismiss <id> <reason>` — culled from the
plugin, see the note above) all read from the current project's `.siltpoke/`
— IDs are local to the project you're in.

---

## Memory system (3-tier prompt)

Brain sees a 3-block system prompt in cache-friendly order:

1. **Personality** — stable, cached
2. **Tier 1 long-term memory** — `~/.siltpoke/memory.json`, learned rules across all your projects
3. **Tier 2 recent feedback** — `{cwd}/.siltpoke/recent_feedback.jsonl`, per-project FIFO of last 20 verdicts

**This path is designed but NOT wired today.** `/siltpoke-dismiss <id> <reason>`
was meant to fire a Reflexion subprocess → extract the lesson → append a
`learned_rule` to tier 1 → next call Siltpoke sees the rule. The command was
culled from the plugin and the function behind it (`runDismiss`) is imported by
nothing, so no dismissal has ever produced a rule. The tier-1 write path that
IS live runs from the opposite signal: you FIX code Siltpoke flagged, git
confirms it mechanically, and a rule is distilled from that validated catch.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| No face in statusline | `cat ~/.claude/settings.json \| jq .statusLine` → should point at Siltpoke wrapper. Then restart Claude Code. |
| Codex does not recognize `/siltpoke-*` | Expected for current Codex support. Use natural language through the installed Siltpoke skill/plugin, for example "open the Siltpoke dashboard". |
| Brain never runs | `/siltpoke-stats` then `tail -f ~/.siltpoke/brain-calls.jsonl` — look for `skipped` reasons: `quiet_hours`, `budget_hard_stop`, `no_change`, `no_new_commit`, `tree_unchanged`, `docs_only`, `not_a_git_repo`. |
| Cache hits always zero | Something's mutating the stable prompt prefix between calls. Check `memory.json` isn't getting rewritten mid-call. |
| Bubble mixes English into non-English | Pull latest — system prompt was tightened. If still happens, file an issue with the bubble text. |
| Start over | `bun run uninstall -- --purge && bun run setup` |
| Upgraded from a pre-per-project Siltpoke and inbox feels stale | Run `bun run migrate-critiques` from the repo to split the old global history into per-project archives. Old `~/.siltpoke/critiques/` stays as backup. |

---

## Uninstall

**Plugin install** (`claude plugin install …`):

```bash
/siltpoke:siltpoke-uninstall                       # 1. in Claude Code: shows what Siltpoke set up, asks about each group, removes the ones you say yes to
claude plugin uninstall siltpoke          # 2. in a terminal: removes the plugin
sh ~/.siltpoke/bin/uninstall.sh --purge   # 3. optional, in a terminal: asks about what is left — your data, and the tools Siltpoke installed
```

Installed Siltpoke for one project only (`--scope local` or `--scope project`)?
Then step 2 answers "not installed in user scope". Run it in that project's
folder and add the same scope: `claude plugin uninstall siltpoke --scope local`.
If you skip this, step 3 refuses and tells you what to run.

Nothing is removed without a yes. Step 1 shows one list first — the status
line, the dashboard's start-at-login entry and server, the menu-bar pet, and
anything a source install left: Siltpoke's hooks in the settings of Claude
Code, codex, codebuddy, qoder and Antigravity, and its slash-command links —
and asks about each group; things that were on your machine before Siltpoke
are listed and left alone. Step 3 asks the same way in the terminal (`y/N`,
default No). Run without a terminal, it prints the list, removes nothing, and
exits 3.

Taking hooks out of another agent's settings file removes Siltpoke's entries
from the Stop and SessionStart hooks and leaves the rest of the file as it
was. One exception, so that a hook left by an earlier Siltpoke checkout goes
too: in a file that holds Siltpoke's own hook, any command that runs a
`…/src/hooks/on-stop.ts`, `codex-stop.ts`, `agy-stop.ts` or
`handle-session-start.ts` is treated as Siltpoke's, whichever folder it is in.
If the file is not valid JSON, it is left untouched and the output says so
(a codex `hooks.json` that is not valid JSON, on a machine with no install
record, is not listed at all). If you already deleted part of Siltpoke's hooks
by hand, what is left may not be recognised: look for `src/hooks/` in the
file. A file Siltpoke wrote that has changed since
(a menu-bar script, a slash-command file) is kept, and the output names it.
The SwiftBar plugin-folder setting is deleted only when Siltpoke's own record
(`~/.siltpoke/receipt.json`) says Siltpoke set it. None of this deletes your
data: `~/.siltpoke`, the `.siltpoke/` folder in each project, and the settings
backups stay until step 3.

Step 3 (`--purge`) asks about four more things, in this order, each on its
own and each defaulting to No. (The order is the terminal's; a single
`--remove <group>` call removes the group it names. Remove the project folders
before `~/.siltpoke`: the list of projects is kept in it.)

1. **The `.siltpoke/` folder inside each project Siltpoke reviewed.** The
   projects are the ones Siltpoke recorded. A folder is kept, and named, when
   git tracks any file in it (then it is part of your project) or when the
   project is a git repository and git could not answer. A recorded project
   that is no longer at its path is named too; Siltpoke does not go looking
   for where it moved.
2. **The copies of `settings.json` that each setup run left** in Claude Code's
   settings folder (`settings.json.pre-siltpoke*`). Your `settings.json` itself
   is not touched.
3. **Tools Siltpoke itself installed, one question each**: the local Ollama
   model (`ollama rm <tag>`), the project-lifecycle plugin
   (`claude plugin uninstall …`), the SwiftBar app (`brew uninstall --cask
   swiftbar`). Each is offered only when Siltpoke's own record
   (`~/.siltpoke/receipt.json`) says Siltpoke installed it, and the line says
   you may be using it elsewhere. The project-lifecycle plugin is not offered
   while a settings file still enables it — your own Claude Code settings, or
   those of a project Siltpoke knows about; the line names the file. Claude
   Code enables a plugin in your own settings when it installs it, so to have
   this one offered, disable it there first. Projects Siltpoke never opened
   cannot be checked. A tool that is on the machine with no record of who
   installed it is listed once with the command to remove it yourself. bun,
   git, Claude Code and codex are never offered.
4. **`~/.siltpoke`**, last. If you kept something Siltpoke installed (said No
   to the model, say) or a project's `.siltpoke/` folder, this folder is
   emptied except `receipt.json`, cut down to the things that are still there,
   so a later run can still offer them; the output says so. Otherwise the whole
   folder goes.

None of the four is removed while Siltpoke's plugin is still installed in any
coding agent, or when Siltpoke cannot tell whether it is: uninstall the plugin
first. For `~/.siltpoke` the reason is that the plugin's hooks would write it
straight back; the same rule is applied to the other three so that there is
one rule to remember.

To look without changing anything:

```bash
bun <plugin folder>/dist/siltpoke-cli.js uninstall --plan --purge
```

**The report.** Every run that asks or removes ends with one. It is read off the disk after the
removals, not off what each step said it did, so an item counts as removed
only when it is no longer found. It says:

- how many items were removed, and how many of them were in Siltpoke's own
  record (`~/.siltpoke/receipt.json`);
- anything you said yes to that is still there;
- the groups you said No to;
- what was left in place and why (it was on your machine before Siltpoke, git
  tracks it, another tool may need it);
- recorded items that were already gone before the run;
- what is **not tracked**: Siltpoke records what it installs only since the
  date the report names. Anything an earlier version installed is not in the
  record, and the report cannot say whether it is still on your machine. For
  that reason it never says the machine is clean.

Empty folders and files that the install itself created are removed with the
rest: the slash-command folders (`~/.claude/commands`, and the same folder in
codebuddy and qoder), and a settings or hooks file the install created in
another coding agent once it holds nothing but `{}`. Siltpoke deletes one only
if its record says the install created it and it is empty at that moment — a
folder or file that was already there, or that you have put anything into,
stays. Known: a machine installed before this was recorded keeps those empty
folders and `{}` files; they are safe to delete by hand.

Step 1 prints a short form after each group and the whole report at the end.
To print it at any time, without changing anything:

```bash
bun <plugin folder>/dist/siltpoke-cli.js uninstall --report
```

If the plugin is removed first, the status line restores itself on its next
draw, and step 3 still works while Claude Code keeps the plugin's files. Once
those files are gone, `uninstall.sh` can no longer ask item by item: it tells
you where the record of what was installed is (`~/.siltpoke/receipt.json`) and
does the rest as before. `--purge` deletes `~/.siltpoke` only when no coding
agent still has the plugin (its hooks would write the folder straight back)
and your status line was put back (the folder holds the only copy of your
original one). Codex is checked with `codex plugin list`, which also lists
plugins that are only available. If Codex is the only place the refusal names
and Codex does not have Siltpoke installed, delete the folder yourself with
`rm -rf ~/.siltpoke`.

If you installed the plugin, uninstalled it, and now run Siltpoke with
`claude --plugin-dir`, your status line shows your own command and the pet
does not come back: the mark Claude Code left on uninstall is still on disk.
To bring the pet back while staying on `--plugin-dir`, delete the copy Claude
Code left behind (`rm -rf ~/.claude/plugins/cache/*/siltpoke`) and run
`/siltpoke:siltpoke-setup` (give your pet's current name and species, or the new
answers replace them; level and XP are kept). Reinstalling the plugin also
works, but Claude Code may then load Siltpoke twice: once from the plugin and
once from your folder.

**Source install** (`bun run setup`):

```bash
bun run uninstall              # take siltpoke out of settings.json, keep ~/.siltpoke/ data
bun run uninstall -- --purge   # same, then delete ~/.siltpoke/ entirely
```

Only what setup wrote into `~/.claude/settings.json` comes out: the status line
you had before goes back (or the `statusLine` entry is removed, if you had
none), and siltpoke's Stop and SessionStart hooks are removed. Every other
setting — including anything you changed after setup — stays as it is. The
backup setup made (`settings.json.pre-siltpoke-*.json`) is kept and named in
the output; it is never copied back. If `settings.json` is not valid JSON, it
is left untouched and the output says so. Run the uninstall from the same
folder you ran setup from: if the checkout has moved since, the status line,
the SessionStart hook and the Stop hook's `bun …` entry name the old folder,
are not recognised, and stay in place.

Installer is **idempotent**. Re-running `bun run setup` after a repo
update will pick up new slash commands (symlinks auto-refresh) without
re-asking your personality questions.
