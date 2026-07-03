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
L7 820/1500
```

Not five tools — **one nervous system**, four organs keyed to a single
project:

- **Critic.** A *separate* `claude -p` subprocess (your existing Claude
  Code login — no extra LLM bill) reviews each turn with its own prompt
  and personality, catching what the writing-side Claude missed. Every
  claim cites file:line evidence. Critiques land on disk — you forward,
  dismiss (it learns), or ignore. Pull, never push.
- **Repo-graph.** A structural map of your codebase it can reason over —
  ask it to explain a file or symbol, grounded in the real call graph.
- **Memory.** Bugs fingerprinted across sessions; facts you tell it
  remembered across projects. Data stays on your disk — no siltpoke
  cloud, no telemetry.
- **Chat.** Talk to it with all of the above in context.

And it's a **Tamagotchi** — pet it, level it up, unlock poses. The pet
is the surface that makes it feel like a companion, not a dashboard.
Runs **~$0.04–$0.10/day** on typical use, thanks to prompt caching.

## Setup (90 seconds)

Need: Claude Code (logged in) + [Bun](https://bun.sh/) `>= 1.0`.
Already have a statusline? Siltpoke wraps it — face renders on top.

```bash
git clone https://github.com/Victoriakaey/siltpoke.git ~/siltpoke
cd ~/siltpoke
bun install
bun run setup        # 4 prompts: statusline, name, species, language
```

Restart Claude Code → ASCII face appears in your statusline. Send any
message → within ~3s Siltpoke says hi. Trouble? `/siltpoke-doctor`
runs 7 install-health checks, or see
[docs § Troubleshooting](https://siltpoke.com/docs.html#troubleshooting).

## Use it with project-life-cycle

Pairs well with
[project-life-cycle](https://github.com/Victoriakaey/project-life-cycle)
— a Claude Code skill adding spec → plan → execute → ship → release
discipline (`/init-harness` → `/ship` → `/release`). project-life-cycle
structures the work; Siltpoke reviews it and remembers what broke.
Better together, fully independent.

```bash
claude plugin marketplace add Victoriakaey/project-life-cycle
claude plugin install project-lifecycle@project-life-cycle
```

## Daily use

The whole loop is 3 commands:

```
/siltpoke-inbox                   List pending critiques
/siltpoke-forward <id>            Pull one into the chat (+10 XP if fresh)
/siltpoke-dismiss <id> <reason>   Reject — Siltpoke learns why it was wrong
```

The dashboard has the rest — state card, critic inbox, chat, memory,
timeline, repo-graph:

```
/siltpoke-report                  Open dashboard → http://127.0.0.1:9876
```

Chat (`/siltpoke-chat`), memory (`/siltpoke-remember`), repo-graph
(`/siltpoke-index` → `/siltpoke-graph` → `/siltpoke-explain`), config,
and the full 35-command reference:
**[docs § Slash commands](https://siltpoke.com/docs.html#slash-commands)**
or `/siltpoke-help` in-chat.

## Uninstall

```bash
bun run uninstall              # restore settings, keep data
bun run uninstall -- --purge   # restore + nuke ~/.siltpoke/
```

## License

Free for **non-commercial use** under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).
Commercial use requires a separate license — contact
**jd.victoria.work@gmail.com**.

Copyright (c) 2026 Jiaqi Duan. All rights reserved.
