// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * An agent CLI's own `--version` line, for the chat call record (spec
 * 2026-10-13 §10.2: ). Asked once per command per
 * lookup and kept; any failure is `null`, never a guess.
 *
 * Bounded no matter what the command does: the answer is null at the deadline
 * even when the command ignores signals or a child of it holds the output pipe
 * open (the hazard chat-provider-stream.ts guards with its own hard kill). The
 * chat reply waits on the record, so an unbounded wait here would hold the
 * reply — and, cached, every later reply from that agent.
 */
import { delimiter } from "node:path";

const VERSION_TIMEOUT_MS = 5_000;

type Runner = (argv: string[]) => Promise<string | null>;

/** Runs `argv` with `commandDir` first on PATH; stdout, or null on a non-zero exit. */
function spawnRunner(commandDir: string | undefined, timeoutMs: number): Runner {
  return async (argv) => {
    const path = process.env.PATH ?? "";
    const env = {
      ...process.env,
      SILTPOKE_INTERNAL: "1",
      PATH: commandDir ? `${commandDir}${delimiter}${path}` : path,
    };
    const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    // unref: a pending kill must not hold the daemon open at shutdown.
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    timer.unref?.();
    try {
      const out = await new Response(proc.stdout).text();
      return (await proc.exited) === 0 ? out : null;
    } finally {
      clearTimeout(timer);
    }
  };
}

const daemonLookups = new Map<string, (command: string) => Promise<string | null>>();

/**
 * The `--version` lookup for commands in `commandDir`. Without `seams` it is
 * the daemon's own, kept for the process's life (one per folder, so each
 * command is asked once). With `seams` (tests) it is a fresh, uncached one.
 */
export function cliVersionLookupFor(
  commandDir: string | undefined,
  seams?: { run?: Runner; timeoutMs?: number },
): (command: string) => Promise<string | null> {
  if (seams !== undefined) return createLookup(seams.run, commandDir, seams.timeoutMs);
  const key = commandDir ?? "";
  let lookup = daemonLookups.get(key);
  if (lookup === undefined) {
    lookup = createLookup(undefined, commandDir);
    daemonLookups.set(key, lookup);
  }
  return lookup;
}

function createLookup(
  run: Runner | undefined,
  commandDir: string | undefined,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): (command: string) => Promise<string | null> {
  const runner = run ?? spawnRunner(commandDir, timeoutMs);
  const cache = new Map<string, Promise<string | null>>();
  return (command) => {
    let hit = cache.get(command);
    if (hit === undefined) {
      const answer = runner([command, "--version"])
        .then((out) => out?.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
        .catch(() => null);
      // The deadline wins even if the runner never settles (a grandchild
      // holding stdout keeps `text()` pending after the kill).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      });
      hit = Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
      cache.set(command, hit);
    }
    return hit;
  };
}
