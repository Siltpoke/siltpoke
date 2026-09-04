# Siltpoke — User Manual

> Daily-use reference. For setup, see [`README.md`](../README.md). This file
> is mirrored by the `/siltpoke-help` slash command — keep them in sync.

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
/siltpoke-dismiss <id> <reason>   Reject + Siltpoke learns from why it was wrong
```

That's the whole loop:

1. Claude finishes a turn → Siltpoke runs in background → review lands in inbox.
2. You run `/siltpoke-inbox` whenever you want.
3. For each pending review:
   - **Useful** → `/siltpoke-forward <id>` (default — XP awarded)
   - **Wrong** → `/siltpoke-dismiss <id> <reason>` (triggers Reflexion → writes a learned rule → Siltpoke won't make the same wrong call again)
   - **Neutral / already-seen** → `/siltpoke-ack <id>` (no XP, no learning)

---

## Daily loop in Codex

**Plugin-native install (recommended):**

```bash
codex plugin marketplace add https://github.com/Siltpoke/siltpoke
codex plugin add siltpoke
codex plugin list                                      # verify: siltpoke … installed, enabled
```

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
| `/siltpoke` | State card — name, level, XP, mood, today's spend |
| `/siltpoke-inbox` | List pending reviews (read-only) |
| `/siltpoke-last` | Surface the most recent review into chat |
| `/siltpoke-forward <id>` | Pull a specific review (+10 XP if fresh) |
| `/siltpoke-forward-all` | Dump every pending review at once |
| `/siltpoke-ack <id>` | Mark acknowledged — neutral, no XP, no learning |
| `/siltpoke-dismiss <id> <reason>` | Reject + trigger Reflexion to learn |
| `/siltpoke-wake` | One-shot bypass of budget + quiet-hours gates |
| `/siltpoke-review` | Alias for `/siltpoke-wake` ("review my work now") |
| `/siltpoke-stats` | Today's token spend + budget stage + review unit |
| `/siltpoke-pet` | +5 XP (shared 100 action-XP/day cap) |
| `/siltpoke-menubar <install\|status\|remove>` | Manage the macOS menu-bar pet (see § below) |
| `/siltpoke-help` | This manual |

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

---

## Daemon autostart (opt-in)

The daemon is **optional**. Core review runs entirely inside the Stop
hook — the daemon only powers the web surfaces (dashboard, floating
chat, repo-index). So `bun run setup` asks "开机自启 siltpoke daemon？"
and defaults to **no**: nothing extra installed, and no `ECONNREFUSED`
on reboot from a hook reaching for a server that isn't there.

Turn it on whenever you want the dashboard — just open it:

```bash
/siltpoke-dashboard    # starts the daemon and enables it so it stays up
```

That flips `daemon.enabled` on in `~/.siltpoke/config.json`, so the
Stop hook keeps the daemon alive from then on. To also survive reboots,
install autostart:

- macOS: a LaunchAgent at `~/Library/LaunchAgents/io.siltpoke.daemon.plist`
  (`RunAtLoad` + `KeepAlive` — relaunches if it crashes).
- Linux: a systemd user unit `siltpoked.service` (`Restart=always`).

Install/refresh any time: `bun src/cli/daemon.ts install-autostart`.
`bun run uninstall` removes it along with everything else.

Two caveats:

- **The plist/unit hardcodes this repo's path.** If you move the repo,
  re-run `install-autostart` to repair it.
- **Daemon off = a sleeping pet, never a red error.** With the daemon
  disabled (the default) the Stop hook does not respawn it — reviews,
  the statusline pet, and the menu-bar pet all keep working without it.
  `/siltpoke-doctor` reads a stopped daemon as a normal info row, and
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
/siltpoke-menubar install   # or: bun src/cli/menubar.ts install
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
gates as everything else — `/siltpoke-mute` and quiet-hours suppress
them exactly like chat-surfaced reviews.

`/siltpoke-menubar status` reports whether the shim is installed;
`/siltpoke-menubar remove` deletes it (running the command is the
consent — no extra prompt, matching `/siltpoke-mute` /
`/siltpoke-unmute`).

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
tests/smoke — `/siltpoke-doctor` shows the effective value and marks
env overrides.

You can also pick **which model** that reviewer runs with the optional
`reviewer_model` key:

```json
{
  "reviewer_provider": "agy",
  "reviewer_model": "gemini-2.5-pro"
}
```

`reviewer_model` reaches `agy` / `qoder` / `codebuddy` as their `--model` flag.
**`codex` ignores it** (the Codex CLI takes no model flag under ChatGPT auth — its
served model is whatever the account defaults to). Unset = each provider's own
default. `/siltpoke-doctor` shows the resolved `model=…` on the reviewer row.

**Scope (allowlist)**: only the per-turn **critic** (and the eval harness)
honor this key. Chat, Code Map explanations, memory extraction, and every other
Brain consumer stay on claude by code — migrating them is tracked separately.

**What to know before switching:**

- **Billing is ChatGPT-plan quota, not dollars.** Codex calls record
  `cost_usd: null` in the ledger (never a fabricated dollar figure); their
  tokens still count against your `dailyTokenLimit`, and a separate
  **50 calls/day cap** brakes runaway quota use.
- **The served model is not pinnable** under ChatGPT auth — siltpoke records
  the configured model from `~/.codex/config.toml` as provenance, and OpenAI
  may rotate what that name maps to.
- **Review quality is eval-gated.** Codex becomes a *documented-supported*
  default only after passing the release gate
  (an internal release gate); switching
  before that works but logs a one-time warning, and `/siltpoke-doctor`'s
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
  before that works but logs a one-time warning, and `/siltpoke-doctor`'s
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
  before that works but logs a one-time warning, and `/siltpoke-doctor`'s
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
  before that works but logs a one-time warning, and `/siltpoke-doctor`'s
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

`/siltpoke-inbox`, `/siltpoke-forward <id>`, `/siltpoke-ack <id>`, and
`/siltpoke-dismiss <id> <reason>` all read from the current
project's `.siltpoke/` — IDs are local to the project you're in.

---

## Memory system (3-tier prompt)

Brain sees a 3-block system prompt in cache-friendly order:

1. **Personality** — stable, cached
2. **Tier 1 long-term memory** — `~/.siltpoke/memory.json`, learned rules across all your projects
3. **Tier 2 recent feedback** — `{cwd}/.siltpoke/recent_feedback.jsonl`, per-project FIFO of last 20 verdicts

`/siltpoke-dismiss <id> <reason>` fires a Reflexion subprocess →
extracts the lesson → appends a `learned_rule` to tier 1 → next call
Siltpoke sees the rule → won't make the same wrong review again.

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

```bash
bun run uninstall              # restore settings.json from backup, keep ~/.siltpoke/ data
bun run uninstall -- --purge   # restore + nuke ~/.siltpoke/ entirely
```

Installer is **idempotent**. Re-running `bun run setup` after a repo
update will pick up new slash commands (symlinks auto-refresh) without
re-asking your personality questions.
