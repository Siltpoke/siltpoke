// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Read an agent process's output without letting a child of it hold the call.
 *
 * Defect [51]: every provider killed the agent on timeout and then read stdout
 * and stderr "to the end". The end is when every holder of the pipe has closed
 * it, and an agent CLI that started a child of its own leaves that child
 * holding the pipe after the parent is gone — so the read waited for the child
 * (a 90-second timeout ran 196 and 271 seconds), and the timeout bounded
 * nothing. The same wait also read stdout fully before starting on stderr, so
 * a chatty stderr could stall the agent until the kill.
 *
 * Here both streams are read at once, and once the process itself has exited
 * they get `graceMs` to finish. After that the reads are cancelled and what
 * arrived is returned. The result has the shape the providers already
 * classified (`exitCode` from the process, the text that was read), so a
 * timeout still reads as the same failure it always did.
 */

/** How long the pipes may stay open after the agent process has exited. */
export const DRAIN_GRACE_MS = 2_000;

/** How long an agent may take to exit after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 2_000;

interface Stoppable {
  kill(signal?: NodeJS.Signals): void;
  /** Absent only on test doubles; then there is no SIGKILL follow-up. */
  exited?: Promise<unknown>;
}

/**
 * SIGTERM now, SIGKILL after `graceMs` if the process is still running.
 *
 * `[51]` follow-up: a timeout sent one SIGTERM and nothing after it, so an
 * agent that ignores SIGTERM never exited — and `drainProcess`, which waits for
 * the exit before its own grace starts, waited with it. Throws only if the
 * first kill throws, so callers keep their existing try/catch.
 */
export function stopProcess(proc: Stoppable, graceMs: number = KILL_GRACE_MS): void {
  // SIGTERM first: a test double without `exited` must still be told to stop.
  proc.kill();
  if (proc.exited === undefined) return;
  let exited = false;
  proc.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  const timer = setTimeout(() => {
    if (exited) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // exited between the check and the kill
    }
  }, graceMs);
  timer.unref?.();
}

interface Collected {
  done: Promise<void>;
  text: () => string;
  cancel: () => void;
}

function collect(source: unknown): Collected {
  const body = source === undefined || source === null ? null : new Response(source as BodyInit).body;
  if (body === null) return { done: Promise.resolve(), text: () => "", cancel: () => {} };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      // Cancelled or broken pipe: keep what arrived.
    }
  })();
  return {
    done,
    text: () => text,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

export interface Drained {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function drainProcess(
  proc: { stdout?: unknown; stderr?: unknown; exited: Promise<number> },
  graceMs: number = DRAIN_GRACE_MS,
): Promise<Drained> {
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } catch (e) {
    out.cancel();
    err.cancel();
    throw e;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    Promise.all([out.done, err.done]).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!finished) {
    out.cancel();
    err.cancel();
  }
  return { stdout: out.text(), stderr: err.text(), exitCode };
}
