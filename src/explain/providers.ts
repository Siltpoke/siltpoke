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
import {
  type BrainUsage,
  extractUsage,
  findResultEvent,
  normalizeStreamEnvelope,
} from "../brain/envelope";
import { drainProcess } from "../brain/drain-process";
import { PROJECT_SETTINGS_OFF } from "../brain/project-settings-off";
import { systemPromptArgs } from "../brain/system-prompt-file";
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
  opts: { resultFilePath?: string; signal?: AbortSignal; cwd?: string },
): { proc: Bun.Subprocess; resultFilePath?: string } {
  const { resultFilePath, signal, cwd } = opts;
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
    // Defect [83]: without this the child runs wherever the daemon was started
    // and reads same-named files from THAT folder.
    ...(cwd ? { cwd } : {}),
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

/**
 * Turn `claude -p --output-format json` stdout into explain's markdown+usage.
 *
 * Exported so the shape handling has a test that runs the real code rather
 * than a re-implementation of it: this is the delivery half of defect [12] and
 * used to be inlined in the provider closure, where nothing could reach it
 * without spawning a paid subprocess.
 *
 * Both envelopes are accepted (see `normalizeStreamEnvelope`): the event array
 * that verbose produces, and the bare `type:"result"` object it does not.
 * `.slice()` on that bare object used to throw a raw TypeError.
 */
export function parseExplainEnvelope(rawStdout: string): {
  markdown: string;
  usage: BrainUsage;
} {
  const ev = findResultEvent(normalizeStreamEnvelope(JSON.parse(rawStdout)));
  if (!ev.result) {
    throw new Error("claude -p result event carried no result text");
  }
  return { markdown: ev.result, usage: extractUsage(ev) };
}

/**
 * The only tools explain's `claude -p` may use: reading, never running,
 * writing or fetching.
 *
 * Defect [83]: with no limit the model opened files on its own, in whatever
 * folder it ran in, and cited their line numbers. Reading stays allowed
 * because the prompt carries only each file's first 600 bytes
 * (`prompt-assembly.ts` `SNIPPET_MAX_BYTES`), so an explanation of anything
 * past that needs the file. The working directory (`spawnArchToFile`'s `cwd`)
 * is what points those reads at the right project.
 */
export const EXPLAIN_TOOLS = "Read,Grep,Glob";

/**
 * `claude -p`'s argv for one explain call, with the system prompt staged for
 * the platform.
 *
 * Lifted out of the provider closure because defect `[26]`'s fix pushed that
 * closure past its length pin, and a pin is a ratchet that only turns down.
 *
 * Defect `[26]`, second face: Code Map's explain spawns the same `claude.cmd`
 * the reviewer does, so on Windows the argv form is refused before the process
 * starts and explain is 100% dead there. The returned `cleanup` MUST run on
 * every exit path of the caller.
 */
function buildExplainArgv(
  model: string,
  systemPrompt: string,
  platform: NodeJS.Platform | undefined,
): { argv: string[]; cleanup: () => void } {
  const promptArgs = systemPromptArgs(systemPrompt, { supportsFile: true, platform });
  return {
    argv: [
      "claude",
      "-p",
      "--model",
      model,
      ...promptArgs.args,
      "--output-format",
      "json",
      // Defect [12] — same reason as brain.ts: the array envelope exists only
      // when verbose is on, and that is the user's setting, not ours.
      "--verbose",
      "--no-session-persistence",
      "--tools",
      EXPLAIN_TOOLS,
      // `--tools` does not reach MCP servers; skip loading the user's.
      "--strict-mcp-config",
      // The child runs in the project's folder: never load its CLAUDE.md or
      // run its hooks (see project-settings-off.ts).
      ...PROJECT_SETTINGS_OFF,
    ],
    cleanup: promptArgs.cleanup,
  };
}

/**
 * A missing folder would fail inside Bun.spawn as `ENOENT … posix_spawn
 * 'claude'`, which reads as "claude is not installed" (defect [83] review).
 */
function assertProjectFolder(cwd: string | undefined): void {
  if (cwd && !existsSync(cwd)) throw new PreSpawnError(`the project folder is gone: ${cwd}`);
}

/** Shells out to `claude -p` with a chosen model (the real reviewer subprocess). */
function makeClaudeProvider(defaultModel: string, envVar: string): BrainProvider {
  return async ({ systemPrompt, contextBundle, signal, onSpawn, resultFilePath, platform, cwd }) => {
    assertProjectFolder(cwd);
    const model = process.env[envVar] ?? defaultModel;
    const { argv, cleanup } = buildExplainArgv(model, systemPrompt, platform);
    // BF1: a spawn-throw means the paid subprocess never existed ($0 spent) —
    // mark it structurally so the daemon's failure ledger can skip it.
    let spawnResult: ReturnType<typeof spawnArchToFile>;
    try {
      spawnResult = spawnArchToFile(argv, { resultFilePath, signal, cwd });
    } catch (e) {
      // Leaves before the finally below is armed — clean up here or the prompt
      // file lingers once per failed explain.
      cleanup();
      throw new PreSpawnError(
        `claude -p never started: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // `finally` rather than a call before each return: the drain below has
    // several exits (non-zero exit, a throw from either Response drain), and
    // the temp prompt file must not survive any of them.
    try {
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
      // drainProcess reads both pipes at once (no pipe-buffer deadlock) and,
      // [51] follow-up, stops reading 2 s after claude exits — a child of it
      // holding a pipe used to hold the explain until the child let go.
      // On the fd path there is no stdout pipe to read.
      const drained = await drainProcess({
        stdout: resultFilePath ? undefined : proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
      });
      const { exitCode, stderr } = drained;
      const rawStdout = resultFilePath ? readFileSync(resultFilePath, "utf8") : drained.stdout;

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
      return parseExplainEnvelope(rawStdout);
    } finally {
      cleanup();
    }
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
