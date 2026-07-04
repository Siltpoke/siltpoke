// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Default source + Brain providers for `runExplain`.
 *
 * Extracted from `src/cli/explain.ts` so both the CLI and
 * the daemon's `POST /api/repo-graph/explain` route construct the same real
 * `claude -p` Brain provider + filesystem source provider.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { BrainProvider, SourceProvider } from "./explain";

/** Reads repo-relative (or absolute) source files for the subgraph bundle. */
export function makeDefaultSourceProvider(projectRoot: string): SourceProvider {
  return async (relPath: string) => {
    if (!relPath) return null;
    const abs = isAbsolute(relPath) ? relPath : join(projectRoot, relPath);
    if (!existsSync(abs)) return null;
    try {
      return await readFile(abs, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Thrown when the run NEVER reached the paid subprocess — `Bun.spawn` itself
 * failed (binary missing → `Executable not found in $PATH` / ENOENT, or
 * EAGAIN under resource pressure) or the prompt couldn't be delivered over
 * stdin. $0 was billed: failure-path cost ledgers must NOT record usage for
 * this class (review BF1 — an "estimated" entry here fabricates ~$1.5 of
 * phantom spend per retry). Structural marker (`preSpawn`) preferred over
 * message-shape matching so detection survives message wording changes.
 */
export class PreSpawnError extends Error {
  readonly preSpawn = true as const;
  constructor(message: string) {
    super(message);
    this.name = "PreSpawnError";
  }
}

/** Structural pre-spawn check: instanceof + duck-type (survives a duplicated
 * module instance in tests/bundles where instanceof would lie). */
export function isPreSpawnError(e: unknown): boolean {
  return (
    e instanceof PreSpawnError ||
    (typeof e === "object" && e !== null && (e as { preSpawn?: unknown }).preSpawn === true)
  );
}

/**
 * Spawn a subprocess writing its stdout kernel-direct to a result file fd.
 *
 * Task 2 / Bug A fix: when a `resultFilePath` is supplied, the child process
 * inherits an fd pointing at the file via `Bun.spawn({ stdout: fd })`. The
 * parent closes its copy of the fd immediately after spawn. The child owns its
 * dup of the fd and writes directly — no daemon-side drain coroutine exists.
 * When the daemon dies mid-run the child's fd is unaffected; the paid result
 * lands in the file regardless of daemon liveness.
 *
 * Without `resultFilePath` the spawn uses `stdout:"pipe"` — byte-identical
 * legacy behaviour for the CLI path.
 */
export function spawnArchToFile(
  argv: string[],
  opts: { resultFilePath?: string; signal?: AbortSignal },
): { proc: Bun.Subprocess; resultFilePath?: string } {
  const { resultFilePath, signal } = opts;
  let stdout: number | "pipe" = "pipe";
  if (resultFilePath) {
    mkdirSync(dirname(resultFilePath), { recursive: true });
    stdout = openSync(resultFilePath, "w");
  }
  const spawnOpts = {
    stdin: "pipe" as const,
    stdout,
    stderr: "pipe" as const,
    env: { ...process.env, SILTPOKE_INTERNAL: "1" },
    ...(signal ? { signal, killSignal: "SIGTERM" as const } : {}),
    ...(resultFilePath ? { detached: true as const } : {}),
  };
  // Finding 1 fix: if Bun.spawn throws (e.g. binary not on PATH → PreSpawnError
  // path), we must close the fd before re-throwing. On the success path the
  // existing closeSync below handles it. try/catch ensures exactly-once close.
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, spawnOpts);
  } catch (e) {
    // Close parent's fd copy before propagating — caller has no fd reference.
    if (typeof stdout === "number") closeSync(stdout);
    throw e;
  }
  // Close the parent's copy of the fd so the child holds the only reference.
  // The child process already inherited its own dup before closeSync runs.
  if (typeof stdout === "number") closeSync(stdout);
  return { proc, resultFilePath };
}

/** Shells out to `claude -p` with a chosen model (the real reviewer subprocess). */
function makeClaudeProvider(defaultModel: string, envVar: string): BrainProvider {
  return async ({ systemPrompt, contextBundle, signal, onSpawn, resultFilePath }) => {
    const model = process.env[envVar] ?? defaultModel;
    const argv = [
      "claude",
      "-p",
      "--model",
      model,
      "--system-prompt",
      systemPrompt,
      "--output-format",
      "json",
      "--no-session-persistence",
    ];
    // BF1: a spawn-throw means the paid subprocess never existed ($0 spent) —
    // mark it structurally so the daemon's failure ledger can skip it.
    let spawnResult: ReturnType<typeof spawnArchToFile>;
    try {
      spawnResult = spawnArchToFile(argv, { resultFilePath, signal });
    } catch (e) {
      throw new PreSpawnError(
        `claude -p never started: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const { proc } = spawnResult;
    onSpawn?.(proc);
    try {
      // stdin is always "pipe" in spawnOpts — cast to the narrowed type that
      // Bun cannot infer from the runtime-computed options object.
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(contextBundle);
      stdin.end();
    } catch (e) {
      // Prompt never delivered → no tokens ever reached the API. Kill the
      // input-less subprocess (best effort) and mark pre-spawn.
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      throw new PreSpawnError(
        `claude -p stdin write failed before the prompt was sent: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Finding 2 fix: split materialization by path to avoid pipe-buffer deadlock.
    //
    // fd path (resultFilePath set): stdout is written kernel-direct by the child
    // to its fd — proc.stdout is null/undefined, no pipe to drain. Drain stderr
    // concurrently, await proc.exited, then await the stderr drain, then read
    // the file. This is safe because there is no stdout pipe that could fill up.
    //
    // CLI path (no resultFilePath): stdout is a pipe. Awaiting proc.exited
    // BEFORE draining proc.stdout risks deadlock when the child's stdout output
    // exceeds the OS pipe buffer (~64 KiB — arch-generate JSON easily does).
    // Restore the pre-92a64cd proven pattern: drain stdout+stderr concurrently
    // via Promise.all, THEN await proc.exited.
    let exitCode: number;
    let rawStdout: string;
    let stderr: string;
    // stderr is always "pipe" in spawnOpts; stdout is "pipe" on CLI path and an
    // fd (null in proc) on the fd path. Cast once so the Response ctor is happy.
    const procStderr = proc.stderr as ReadableStream<Uint8Array>;
    if (resultFilePath) {
      // fd path — no stdout pipe; drain only stderr concurrently.
      const stderrPromise = new Response(procStderr).text();
      exitCode = await proc.exited;
      stderr = await stderrPromise;
      rawStdout = readFileSync(resultFilePath, "utf8");
    } else {
      // CLI path — stdout is a pipe; drain stdout+stderr concurrently BEFORE
      // awaiting proc.exited to prevent pipe-buffer deadlock.
      const procStdout = proc.stdout as ReadableStream<Uint8Array>;
      const [rawOut, rawErr] = await Promise.all([
        new Response(procStdout).text(),
        new Response(procStderr).text(),
      ]);
      exitCode = await proc.exited;
      rawStdout = rawOut;
      stderr = rawErr;
    }

    if (exitCode !== 0) {
      // Both tails, source-labeled: `--output-format json` reports errors on
      // STDOUT (the 2026-06-10 7-min claude-code failure had an empty stderr),
      // so stderr alone leaves the task record blind.
      const parts: string[] = [];
      const errTail = stderr.trim().slice(-500);
      const outTail = rawStdout.trim().slice(-500);
      if (errTail) parts.push(`stderr tail: ${errTail}`);
      if (outTail) parts.push(`stdout tail: ${outTail}`);
      throw new Error(`claude -p exited ${exitCode}${parts.length ? `: ${parts.join(" | ")}` : ""}`);
    }
    const events = JSON.parse(rawStdout) as Array<{
      type?: string;
      result?: string;
      total_cost_usd?: number;
      usage?: {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    }>;
    const finalEvent = events
      .slice()
      .reverse()
      .find((e) => e.type === "result");
    if (!finalEvent || !finalEvent.result) {
      throw new Error("claude -p stream had no result event");
    }
    const usage = finalEvent.usage ?? {};
    return {
      markdown: finalEvent.result,
      usage: {
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        total_cost_usd: finalEvent.total_cost_usd ?? null,
      },
    };
  };
}

/** Explain's reviewer (Haiku default — cheap, single-symbol). */
export function makeDefaultBrainProvider(): BrainProvider {
  return makeClaudeProvider("claude-haiku-4-5", "SILTPOKE_EXPLAIN_MODEL");
}

/** The architecture-view generate (Sonnet default — whole-repo, quality matters). */
export function makeArchBrainProvider(): BrainProvider {
  return makeClaudeProvider("claude-sonnet-4-6", "SILTPOKE_ARCH_MODEL");
}
