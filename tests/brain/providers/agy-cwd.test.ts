// Prompt-injection [A] (2026-10-21): spawned in the reviewed repo, agy obeyed its
// GEMINI.md / AGENTS.md / skills and ran its .agents/hooks.json commands, --sandbox
// notwithstanding. So the spawn cwd is a fresh empty temp dir, never opts.cwd.
// Evidence: an internal design note Fake spawnFn only —
// NEVER spawns the real agy binary.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../../src/brain/brain";
import { classifyBrainFailure } from "../../../src/brain/failure-classify";
import { makeAgyProvider } from "../../../src/brain/providers/agy";

// Same hermetic homes as agy.test.ts: call() runs the conversation reaper, which
// must never reach the real ~/.gemini/ or ~/.siltpoke/.
let sandboxHome: string;
const prev = { gemini: process.env.ANTIGRAVITY_HOME, siltpoke: process.env.SILTPOKE_HOME };

beforeAll(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "agy-cwd-test-sandbox-"));
  process.env.ANTIGRAVITY_HOME = join(sandboxHome, "gemini-home");
  process.env.SILTPOKE_HOME = join(sandboxHome, "siltpoke-home");
});

afterAll(() => {
  if (prev.gemini === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = prev.gemini;
  if (prev.siltpoke === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = prev.siltpoke;
  rmSync(sandboxHome, { recursive: true, force: true });
});

const HAPPY_JSON = JSON.stringify({
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
});

function cwdSpy(exitCode = 0): {
  spawnFn: typeof Bun.spawn;
  seen: { cwd: string; entriesAtSpawn: string[] }[];
} {
  const seen: { cwd: string; entriesAtSpawn: string[] }[] = [];
  const spawnFn = ((_cmd: string[], options: unknown) => {
    const cwd = (options as { cwd: string }).cwd;
    seen.push({ cwd, entriesAtSpawn: readdirSync(cwd) });
    return {
      stdout: new Response(exitCode === 0 ? HAPPY_JSON : "").body,
      stderr: new Response(exitCode === 0 ? "" : "boom").body,
      exited: Promise.resolve(exitCode),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, seen };
}

test("spawn cwd is a fresh empty temp dir, never the reviewed repo (agy auto-loads and runs whatever its cwd holds)", async () => {
  const reviewedRepo = mkdtempSync(join(tmpdir(), "agy-test-reviewed-repo-"));
  writeFileSync(join(reviewedRepo, "GEMINI.md"), "planted");
  const { spawnFn, seen } = cwdSpy();

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", cwd: reviewedRepo, spawnFn });

  expect(seen).toHaveLength(1);
  expect(seen[0]!.cwd).not.toBe(reviewedRepo);
  expect(seen[0]!.cwd).not.toBe(process.cwd());
  expect(seen[0]!.cwd.startsWith(join(tmpdir(), "siltpoke-agy-cwd-"))).toBe(true);
  expect(seen[0]!.entriesAtSpawn).toEqual([]);
  rmSync(reviewedRepo, { recursive: true, force: true });
});

test("spawn cwd is not process.cwd() when opts.cwd is omitted/empty either", async () => {
  const { spawnFn, seen } = cwdSpy();

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", cwd: "", spawnFn });

  expect(seen[0]!.cwd).not.toBe(process.cwd());
  expect(seen[0]!.entriesAtSpawn).toEqual([]);
});

test("each call gets its own cwd, and it is removed after the call", async () => {
  const { spawnFn, seen } = cwdSpy();

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn });
  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn });

  expect(seen).toHaveLength(2);
  expect(seen[0]!.cwd).not.toBe(seen[1]!.cwd);
  expect(existsSync(seen[0]!.cwd)).toBe(false);
  expect(existsSync(seen[1]!.cwd)).toBe(false);
});

test("an uncreatable cwd is an ambiguous BrainError (not 'binary missing') and agy is never spawned", async () => {
  const { spawnFn, seen } = cwdSpy();
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = join(sandboxHome, "no", "such", "dir");
  let caught: unknown;
  try {
    await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn });
  } catch (err) {
    caught = err;
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }
  expect(caught).toBeInstanceOf(BrainError);
  const failure = (caught as BrainError).failure!;
  expect(failure.stderr).toContain("ENOENT");
  // ENOENT under spawnError would latch the breaker as "permanent" until /siltpoke-wake.
  expect(classifyBrainFailure(failure)).toBe("ambiguous");
  expect(seen).toHaveLength(0);
});

test("the cwd is removed even when agy exits non-zero", async () => {
  const { spawnFn, seen } = cwdSpy(1);

  await expect(makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn })).rejects.toThrow(BrainError);

  expect(seen).toHaveLength(1);
  expect(existsSync(seen[0]!.cwd)).toBe(false);
});
