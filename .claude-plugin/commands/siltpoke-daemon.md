---
description: Manage the Siltpoke daemon (siltpoked) — start, stop, status, install-autostart
---

# /siltpoke-daemon

Run `bun siltpoke-daemon $ARGUMENTS` against the local Siltpoke repo to manage the background daemon that owns `127.0.0.1:9876` (Stop hook receiver + dashboard + chat).

Subcommands:

- `start` — boot the daemon in the foreground (Ctrl-C stops)
- `start --detach` — boot the daemon detached (nohup-style)
- `stop` — send SIGTERM to the running daemon
- `status` — print pid + alive/stale
- `install-autostart` — write a LaunchAgent (macOS) or systemd-user unit (Linux) so the daemon starts on login

The daemon also auto-spawns lazily from the Stop hook fallback path; you only need `install-autostart` if you want zero-cold-start before the first Stop event of a session.
