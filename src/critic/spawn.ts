// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export type SpawnWithTimeoutOpts = {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  stdin?: string; // optional: pipe stdin to the process
};

export type SpawnWithTimeoutResult = {
  exitCode: number | null; // null on timeout
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Spawn a binary with a hard timeout. AbortController is owned here (Bun.spawn
 * does not honor AbortSignal, so we also manually call proc.kill() on timeout).
 * proc.exited is awaited inside a fire-and-forget catch to reap zombies.
 */
export async function spawnWithTimeout(
  opts: SpawnWithTimeoutOpts,
): Promise<SpawnWithTimeoutResult> {
  const { argv, cwd, env, timeoutMs, stdin } = opts;

  let proc: ReturnType<typeof Bun.spawn> | undefined;

  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      cwd,
      env: env !== undefined ? env : undefined,
    });
  } catch {
    // ENOENT or other spawn error — binary not found
    return {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  type RaceResult =
    | { kind: "exited"; code: number | null }
    | { kind: "timeout" };

  const timeoutPromise = new Promise<RaceResult>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc?.kill();
      } catch {
        // ignore kill errors
      }
      // Reap zombie — exited never awaited on timeout path
      proc?.exited.catch(() => {});
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });

  let raceResult: RaceResult;
  try {
    raceResult = await Promise.race([
      proc.exited.then((code): RaceResult => ({ kind: "exited", code: typeof code === "number" ? code : null })),
      timeoutPromise,
    ]);
  } catch {
    raceResult = { kind: "exited", code: null };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  let stdout = "";
  let stderr = "";

  // proc.stdout / proc.stderr are ReadableStream when spawn() was given stdout/stderr: "pipe".
  // Bun's type union allows `number | ReadableStream | undefined` so we narrow before Response().
  const outStream = proc.stdout;
  const errStream = proc.stderr;

  if (outStream instanceof ReadableStream) {
    try {
      stdout = await new Response(outStream).text();
    } catch {
      // partial read on timeout — best-effort
    }
  }

  if (errStream instanceof ReadableStream) {
    try {
      stderr = await new Response(errStream).text();
    } catch {
      // partial read on timeout — best-effort
    }
  }

  if (raceResult.kind === "timeout") {
    return { exitCode: null, stdout, stderr, timedOut: true };
  }

  return {
    exitCode: raceResult.code,
    stdout,
    stderr,
    timedOut: false,
  };
}
