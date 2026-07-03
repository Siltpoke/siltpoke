---
description: Siltpoke usage manual — slash commands, daily flow, config, troubleshooting.
---

The user wants to learn how to use Siltpoke. Show them the manual below
verbatim — do NOT paraphrase, summarize, or translate it unless they
asked in a follow-up question.

If they ask a specific follow-up ("how does dismiss learn?", "what's
quiet hours?"), answer using the relevant section + your knowledge of
the config schema.

---

```
 ╭──────────────────────────────────────────────────────────╮
 │  Siltpoke — Manual                                       │
 ╰──────────────────────────────────────────────────────────╯
```

## What Siltpoke does

A separate `claude -p` subprocess reads over Claude's shoulder after
every turn, finds bugs Claude missed, and writes a critique to disk.
**Critiques never auto-inject into your chat** — you pull them in
explicitly when you want them.

## Daily loop (the 3 commands you'll actually use)

```
/siltpoke-inbox            List pending critiques (read-only)
/siltpoke-forward <id>     Pull a specific critique into the chat (+20 XP if fresh)
/siltpoke-dismiss <id> <reason>   Reject + Siltpoke learns from why it was wrong
```

That's the whole loop:

1. Claude finishes a turn → Siltpoke runs in background → critique lands in inbox.
2. You run `/siltpoke-inbox` whenever you want.
3. For each pending critique:
   - **Useful** → `/siltpoke-forward <id>` (default — XP awarded)
   - **Wrong** → `/siltpoke-dismiss <id> <reason>` (triggers Reflexion → writes a learned rule → Siltpoke won't make the same wrong call again)
   - **Neutral / already-seen** → `/siltpoke-ack <id>` (no XP, no learning)

## Quick commands

```
/siltpoke                  State card — name, level, XP, mood, today's spend
/siltpoke-last             Surface the most recent critique
/siltpoke-forward-all      Dump every pending critique at once
/siltpoke-stats            Today's token spend + budget stage + trigger mode
/siltpoke-pet              +5 XP (capped at 3 pets/day = 15 XP/day)
/siltpoke-wake             One-shot bypass of budget + quiet-hours gates
/siltpoke-review           Alias for /siltpoke-wake ("review my work now")
/siltpoke-help             This manual
```

## Trigger modes

When Siltpoke actually runs Brain:

| Mode | Behavior |
|---|---|
| `always` | Every supported event (most expensive) |
| `gates` (default) | Only on configured `gateEvents` (default: `Stop` + `PreCompact`) |
| `on_demand` | Never, unless `/siltpoke-wake` was just used |
| `hybrid` | `gates` + `/siltpoke-wake` always bypasses |

Change in `~/.siltpoke/config.json` → `"triggerMode": "on_demand"`.

## Cost control

Default `~$0.04–$0.10/day` thanks to prompt caching (~70k tokens cached,
calls 2+ cost ~$0.001). Knobs:

```json
{
  "triggerMode": "on_demand",
  "budget": { "dailyTokenLimit": 100000 },
  "quietHours": { "start": "23:00", "end": "08:00" }
}
```

- Budget hard-stop → pet flips to `sleeping_broke`, Brain skipped until midnight reset.
- Quiet hours → Brain muted overnight.
- `dailyTokenLimit: 0` disables the budget gate entirely.

## Pet system

XP sources:

- `/siltpoke-forward <id>` on a fresh critique → **+20 XP**
- `/siltpoke-pet` → **+5 XP** (max 3/day)
- Brain's own `xp_earned_events` for sustained engagement

`xp_to_next_level = 100 × level`. Unlocks: pose `peek` (L2), title
`Watcher` (L2), pose `blink` (L3), title `Apprentice` (L5), title
`Sentinel` (L10). XP never decreases — wrong critiques are handled via
dismiss/Reflexion, not by punishment.

## Re-roll personality

```bash
bun run edit-personality       # name, species, dials, language — Enter keeps old value
```

Or edit `~/.siltpoke/config.json` directly:

```json
{
  "snark": 7,
  "patience": 4,
  "rigor": 6,
  "chattiness": 5,
  "curiosity": 8
}
```

## Files Siltpoke owns

```
~/.siltpoke/                  # global
  config.json                 # personality + budget + trigger
  memory.json                 # tier 1: learned rules (Reflexion writes here)
  progression.json            # XP, level, unlocks
  state.json                  # latest Brain output (fallback)
  brain-calls.jsonl           # every Brain call (debugging)
  critiques/                  # pending + history

{project}/.siltpoke/          # per-project
  state.json                  # this project's latest output
  recent_feedback.jsonl       # tier 2: per-project FIFO of last 20 verdicts
```

## Troubleshooting

| Symptom | Check |
|---|---|
| No face in statusline | `cat ~/.claude/settings.json | jq .statusLine` → should point at Siltpoke wrapper. Then restart Claude Code. |
| Brain never runs | `/siltpoke-stats` then `tail -f ~/.siltpoke/brain-calls.jsonl` — look for `skipped` reasons: `quiet_hours`, `budget_hard_stop`, `no_change`, `wrong_event_mode`, `on_demand_no_bypass`. |
| Cache hits always zero | Something's mutating the stable prompt prefix between calls. Check `memory.json` isn't getting rewritten mid-call. |
| Start over | `bun run uninstall -- --purge && bun run setup` |

## Uninstall

```bash
bun run uninstall              # restore settings, keep data
bun run uninstall -- --purge   # restore + nuke ~/.siltpoke/
```

---

Full doc with deeper sections (match modes, memory tiers, file layout
details): `docs/MANUAL.md`. Setup walkthrough: `README.md`.
