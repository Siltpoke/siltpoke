// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The hook guard, in TypeScript — the Windows half of what `hooks/stop.sh` and
 * `hooks/session-start.sh` do on Unix. This file is the bundle entrypoint and
 * owns everything that touches the outside world; the decisions live next door
 * in `hook-guard-core.ts`.
 *
 * WHY THIS EXISTS AT ALL. `hooks/hooks.json` registers the review hook as
 * `sh "…/hooks/stop.sh"`. Native Windows has no `sh` on PATH, so the host cannot
 * start the command — and because the guard's whole contract is silence, the
 * user sees a pet, working commands and a config file that says "installed",
 * while no review ever fires and nothing says why. The manifest now carries a
 * second command that runs a small PowerShell launcher, and the launcher hands
 * the payload here.
 *
 * WHY TYPESCRIPT RATHER THAN A POWERSHELL PORT of those 108 lines: almost all of
 * `stop.sh` is failure-mode defence earned the hard way, and a second copy in a
 * shell dialect with different failure semantics would have to be kept in step
 * by hand forever. This is the one language the repo already ships on every
 * platform. The `.ps1` files hold no product logic — they find bun and hand over.
 *
 * WHAT IT INHERITS, and what may never be relaxed:
 *   - NOTHING here may reach the user's session. Not a warning, not a stack
 *     trace, not a "couldn't find bun". Every failure is `exit 0` in silence.
 *     `--self-test` is the single exception and it is never used by a hook.
 *   - The payload is drained from stdin on EVERY path, before any decision. A
 *     hook that leaves stdin unread can make the host block on its pipe write.
 *   - Even a crashing bundle exits 0. The bundle logs its own fatals.
 *
 * The Unix `.sh` guards are NOT retired by this file (spec D5). They are the
 * path every existing user depends on; this twin is proven on Windows first.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { recordLastHost } from "../installer/last-host";
import { siltpokeRoot } from "../installer/paths";
import { isSiltpokeInternal } from "../router/router";
import {
  decide,
  defaultGuardDir,
  type GuardOutcome,
  hostFamilyFor,
  nudgeLine,
  parseGuardMode,
  selfTestLine,
  writePluginRootPointer,
} from "./hook-guard-core";

/**
 * Append an unanticipated failure to the same log the bundle uses for its own
 * fatals, so "no reviews on Windows" leaves evidence somewhere.
 *
 * Best-effort and silent: if the log cannot be written, the guard still exits 0
 * without a word.
 */
function logInternalError(err: unknown): void {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      where: "hook-guard",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    appendFileSync(join(siltpokeRoot(process.env), "hook-guard-errors.jsonl"), `${line}\n`);
  } catch {
    // no home, no disk, no permission — nothing to do but stay quiet
  }
}

/**
 * Read all of stdin as BYTES.
 *
 * Bytes rather than a string, and not as a style preference: Windows PowerShell
 * 5.1 does not default to UTF-8 on its pipes, so a payload carrying CJK or emoji
 * — which this product's transcripts routinely do — can be mangled by a string
 * round-trip. The guard would then fail to parse the JSON and, obeying its own
 * never-print contract, exit 0 in silence: the very defect this file exists to
 * remove, reproduced by the fix for it. The launcher hands over bytes and they
 * are forwarded untouched.
 */
export async function readStdinBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Write to a stream and wait for the write to be ACCEPTED, not merely queued.
 *
 * `process.stderr.write` returns before the bytes necessarily reach the OS, and
 * stdio writes to a pipe are synchronous on POSIX but **asynchronous on
 * Windows** — the only platform this file runs on. Calling `process.exit(0)`
 * straight after the write could therefore drop or truncate the one line this
 * guard is allowed to print, on exactly the platform where it matters. A macOS
 * test cannot catch it, because POSIX makes the same code safe. Caught in
 * review, 2026-09-24.
 */
function writeAndFlush(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => {
    stream.write(text, () => done());
  });
}

async function runBundle(outcome: Extract<GuardOutcome, { action: "run" }>, payload: Buffer) {
  await new Promise<void>((done) => {
    const child = spawn(outcome.bun, [outcome.bundle], {
      env: { ...process.env, SILTPOKE_HOST: outcome.hostFamily },
      // Stricter than `hooks/stop.sh:104`, which applies no redirection at all.
      // Harmless today — neither bundle writes to stdout, and `on-stop.ts` logs
      // its own fatals to a file rather than printing. Recorded because it is a
      // real asymmetry: if a bundle ever did print, Unix would leak it into the
      // session and Windows would swallow it.
      stdio: ["pipe", "ignore", "ignore"],
    });
    // Deliberate: even a crashing bundle must not surface an error in the
    // user's session. Both the spawn error and a non-zero exit resolve the
    // same way — the bundle logs its own fatals under the siltpoke home.
    child.on("error", () => done());
    child.on("close", () => done());
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

/**
 * The wrapper. Drains stdin first, decides, acts, and exits 0 no matter what.
 *
 * Everything that could print lives here, in a surface small enough for a test
 * to assert on directly — which is the point of keeping `decide` pure.
 */
export async function main(argv: string[], stdin: NodeJS.ReadableStream): Promise<void> {
  const selfTest = argv.includes("--self-test");
  const mode = parseGuardMode(argv);

  // Before any decision, on every path — including --self-test, so that a probe
  // behaves exactly like a real turn rather than testing a different code path.
  const payload = await readStdinBytes(stdin);

  // Defect [73]: a child session siltpoke itself spawned (SILTPOKE_INTERNAL=1)
  // must write nothing — not even the plugin-root pointer below. Same marker
  // and same early exit as hooks/stop.sh / hooks/session-start.sh.
  // `--self-test` is exempt from the early return so /siltpoke:siltpoke-doctor's probe
  // still prints its line; the pointer write below stays off either way.
  const internal = isSiltpokeInternal(process.env);
  if (internal && !selfTest) return;

  // Unconditional, and before any gating — see writePluginRootPointer. Not for
  // `codex-session-start`: `hooks/codex-session-start.sh` writes no pointer.
  if (mode === "session-start" && !internal) writePluginRootPointer(process.env, defaultGuardDir());

  // Defect [49]: record which agent this event came from, for the dashboard
  // daemon — the same record hooks/lib/record-host.sh keeps on Unix, on both
  // events and before any gating. Not for `--self-test`: a doctor probe is not
  // a turn, and it may run from another agent's shell. A child siltpoke spawned
  // (the marker) never gets here except as a self-test — see the return above.
  if (!selfTest) recordLastHost(process.env, hostFamilyFor(mode, process.env));

  let outcome: GuardOutcome;
  try {
    // Under the marker (only reachable via --self-test) the nudge marker must not
    // land either: a no-op writer returning false also suppresses the nudge text.
    outcome = decide(mode, internal ? { env: process.env, writeNudgeMarker: () => false } : { env: process.env });
  } catch (err) {
    // Only reachable when decide() throws something it did NOT anticipate — it
    // already handles a missing HOME itself. That is a programming error, and
    // labelling it "no-home" would make a real bug permanently indistinguishable
    // from an unset environment variable. It gets its own reason and a line in
    // the same log the bundle writes its fatals to, so a Windows user with no
    // reviews leaves a trail. Still silent in the session. Caught in review.
    logInternalError(err);
    outcome = { action: "exit", reason: "internal-error", nudge: null };
  }

  if (selfTest) {
    await writeAndFlush(process.stdout, `${selfTestLine(outcome)}\n`);
    return;
  }

  if (outcome.action === "exit") {
    // stdout, as `systemMessage` JSON — the only channel a host shows for an
    // exit-0 hook (defect [33]; see nudgeLine). The launcher passes this
    // process's stdout through; it never carries a bundle's output, because
    // runBundle gives the bundle stdio "ignore".
    if (outcome.nudge) await writeAndFlush(process.stdout, nudgeLine(outcome.nudge));
    return;
  }

  try {
    await runBundle(outcome, payload);
  } catch {
    // unreachable by construction — runBundle resolves on every path — but a
    // guard that can throw is a guard that can print.
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), process.stdin)
    .catch(() => {})
    .finally(() => process.exit(0));
}
