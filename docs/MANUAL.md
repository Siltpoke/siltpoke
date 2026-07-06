# Siltpoke — User Manual

> Daily-use reference. For setup, see [`README.md`](../README.md). This file
> is mirrored by the `/siltpoke-help` slash command — keep them in sync.

---

## What Siltpoke does

A separate `claude -p` subprocess reads over Claude's shoulder after
every turn, finds bugs Claude missed, and writes a review to disk.
**Reviews never auto-inject into your chat** — you pull them in
explicitly when you want them.

---

## Daily loop (the 3 commands you'll actually use)

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

## Full slash-command reference

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
| `/siltpoke-stats` | Today's token spend + budget stage + trigger mode |
| `/siltpoke-pet` | +5 XP (shared 100 action-XP/day cap) |
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

## Trigger modes

Controls *when* Siltpoke actually runs Brain:

| Mode | Behavior |
|---|---|
| `always` | Every supported event (most expensive) |
| `gates` (default) | Only on configured `gateEvents` (default: `Stop` + `PreCompact`) |
| `on_demand` | Never, unless `/siltpoke-wake` was just used |
| `hybrid` | `gates` + `/siltpoke-wake` always bypasses |

Change in `~/.siltpoke/config.json`:

```json
{
  "triggerMode": "on_demand"
}
```

---

## Cost control

Default `~$0.04–$0.10/day` thanks to prompt caching (~70k tokens cached,
calls 2+ cost ~$0.001).

```json
{
  "triggerMode": "on_demand",
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
| Brain never runs | `/siltpoke-stats` then `tail -f ~/.siltpoke/brain-calls.jsonl` — look for `skipped` reasons: `quiet_hours`, `budget_hard_stop`, `no_change`, `wrong_event_mode`, `on_demand_no_bypass`. |
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
