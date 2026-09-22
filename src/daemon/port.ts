// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The single reader of the daemon's port from the environment.
 *
 * WHY THIS MODULE EXISTS — the CLI and the Stop hook used to read two different
 * variable names for the same port (`PORT` in `src/cli/daemon.ts` and
 * `src/cli/daemon-restart.ts`, `SILTPOKE_DAEMON_PORT` in `src/hooks/on-stop.ts`).
 * Both defaulted to 9876, so nothing was visibly broken until a user set one of
 * them: then the daemon listened on one port while the hook probed the other,
 * decided no daemon was running, and respawned against a live one. Audit defect
 * `[5b]` — an internal design note.
 *
 * `SILTPOKE_DAEMON_PORT` is the name going forward: it is namespaced, so it
 * cannot be claimed by an unrelated tool in the same shell. Bare `PORT` is still
 * honoured as a fallback because it is what the CLI has always read, and
 * dropping it would silently relocate an existing user's daemon.
 *
 * `tests/daemon/daemon-port.test.ts` holds the guard that keeps this the only
 * reader.
 */

export const DEFAULT_DAEMON_PORT = 9876;

/** The environment shape both surfaces can supply — `process.env` fits it. */
export type PortEnv = Record<string, string | undefined>;

/**
 * Resolve the port the dashboard daemon listens on and the hook probes.
 *
 * Precedence: `SILTPOKE_DAEMON_PORT`, then legacy `PORT`, then 9876. A value
 * that is not a usable TCP port — empty, non-numeric, non-integer, or outside
 * 1–65535 — falls back to the default rather than propagating `NaN` into
 * `Bun.serve`, which is what the old inline `Number(env.PORT)` call sites did.
 */
export function resolveDaemonPort(env: PortEnv): number {
  for (const name of ["SILTPOKE_DAEMON_PORT", "PORT"]) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) continue;
    return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/**
 * True if the `/api/ping` body identifies the responder as siltpoked.
 *
 * WHY THE BODY AND NOT JUST 2xx — audit defect `[5b]`. The old check accepted
 * any 2xx, and plenty of ordinary dev servers answer 200 to an unknown path (a
 * SPA catch-all serving index.html is the usual one). A stranger on 9876 was
 * therefore reported to the user as `siltpoked already running on
 * http://127.0.0.1:9876`, pointing them at a URL that is not siltpoke and
 * hiding the real problem — the port is taken.
 *
 * Two accepted shapes, on purpose. `service: "siltpoked"` is the durable marker
 * going forward. The legacy trio is kept because a siltpoked from before that
 * field existed may be the very daemon holding the port during an upgrade;
 * rejecting it would turn a graceful step-down into an EADDRINUSE crash-flap
 * under launchd KeepAlive. `ok` alone is deliberately NOT enough — it is the
 * most common health-check shape there is and identifies nothing.
 */
export function isSiltpokedPing(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.service === "siltpoked") return true;
  return (
    b.ok === true &&
    typeof b.pid === "number" &&
    (b.mode === "project" || b.mode === "global")
  );
}

/**
 * `JSON.parse` that returns `null` instead of throwing.
 *
 * WHY IT EXISTS — a probe has to tell two things apart that both surface as an
 * exception from `res.json()`: a body that is not JSON (a stranger answered)
 * and a body that could not be READ (a timeout, a truncated response — the
 * real daemon, briefly slow). Reading the body as text first and parsing here
 * keeps them separate: a failed read still throws, a non-JSON body returns
 * `null`. See `checkDaemonAlive` in `src/cli/doctor-daemon-check.ts`.
 */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
