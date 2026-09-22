// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// reviewer_model plumbing — end-to-end argv proof (single-brain #10 critic half).
//
// Verifies the FULL config -> resolveRole -> provider argv path, not just the
// provider adapters in isolation: a top-level `reviewer_model` in config.json
// parses (brain-config), resolves onto the review role's `.model` (registry),
// and reaches the spawned `--model` argv for the model-honoring families
// (agy / qoder / codebuddy). codex has NO `--model` flag under ChatGPT auth,
// so a configured reviewer_model is resolved (present on the role) but a
// deliberate no-op in the spawn argv.
//
// NEVER spawns a real CLI — every call uses a capturing fake spawnFn. argv is
// recorded synchronously at spawn time, so the assertion holds regardless of
// whether the canned stdout parses (calls are wrapped in try/catch).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILIES, parseBrainConfig } from "../../src/brain/brain-config";
import type { CallBrainOptions } from "../../src/brain/brain";
import {
  familySupportsModelChoice,
  providerForFamily,
  resolveRole,
} from "../../src/brain/registry";

// agy's call() runs a best-effort conversation-DB reaper on every call. Point
// both homes at a throwaway dir so this suite can never touch the real
// ~/.gemini / ~/.siltpoke (mirrors tests/brain/providers/agy.test.ts).
let sandboxHome: string;
let prevAntigravityHome: string | undefined;
let prevSiltpokeHome: string | undefined;

beforeAll(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "reviewer-model-plumbing-"));
  prevAntigravityHome = process.env.ANTIGRAVITY_HOME;
  prevSiltpokeHome = process.env.SILTPOKE_HOME;
  process.env.ANTIGRAVITY_HOME = join(sandboxHome, "gemini-home");
  process.env.SILTPOKE_HOME = join(sandboxHome, "siltpoke-home");
});

afterAll(() => {
  if (prevAntigravityHome === undefined) delete process.env.ANTIGRAVITY_HOME;
  else process.env.ANTIGRAVITY_HOME = prevAntigravityHome;
  if (prevSiltpokeHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = prevSiltpokeHome;
  rmSync(sandboxHome, { recursive: true, force: true });
});

// Fake proc that captures argv and replays empty streams. stdin is a no-op
// (agy ignores it; the CC-fork/codex adapters write context to it harmlessly).
function capturingSpawn(sink: { argv?: string[] }): typeof Bun.spawn {
  return ((cmd: string[], _options: unknown) => {
    sink.argv = cmd;
    return {
      stdin: { write(_s: string) {}, end() {} },
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

// Resolve the review role from a config.json string, then invoke the resolved
// provider with the resolved model + a capturing spawnFn. Returns the argv the
// provider tried to spawn (parse failures are swallowed — argv is what matters).
async function argvForConfig(configJson: string): Promise<string[]> {
  const resolved = resolveRole(parseBrainConfig(configJson), "review");
  const sink: { argv?: string[] } = {};
  const opts: CallBrainOptions = {
    systemPrompt: "REVIEW RUBRIC",
    contextBundle: "diff --git a/x.ts",
    cwd: "/repo/under/review",
    model: resolved.model,
    spawnFn: capturingSpawn(sink),
  };
  try {
    await resolved.provider.call(opts);
  } catch {
    // Empty stdout -> parse/exit failure is expected; argv already captured.
  }
  return sink.argv ?? [];
}

test("agy: reviewer_model reaches the spawned --model argv", async () => {
  const argv = await argvForConfig(
    JSON.stringify({ reviewer_provider: "agy", reviewer_model: "gemini-3-pro" }),
  );
  expect(argv[0]).toBe("agy");
  const idx = argv.indexOf("--model");
  expect(idx).toBeGreaterThan(-1);
  expect(argv[idx + 1]).toBe("gemini-3-pro");
});

test("qoder: reviewer_model reaches the spawned --model argv", async () => {
  const argv = await argvForConfig(
    JSON.stringify({ reviewer_provider: "qoder", reviewer_model: "Lite" }),
  );
  expect(argv[0]).toBe("qodercli");
  const idx = argv.indexOf("--model");
  expect(idx).toBeGreaterThan(-1);
  expect(argv[idx + 1]).toBe("Lite");
});

test("codebuddy: reviewer_model reaches the spawned --model argv", async () => {
  const argv = await argvForConfig(
    JSON.stringify({ reviewer_provider: "codebuddy", reviewer_model: "gemini-3.1-pro" }),
  );
  expect(argv[0]).toBe("codebuddy");
  const idx = argv.indexOf("--model");
  expect(idx).toBeGreaterThan(-1);
  expect(argv[idx + 1]).toBe("gemini-3.1-pro");
});

// Until 2026-09-12 this test asserted the model RESOLVED onto the codex role and
// was merely "a no-op in argv" — it pinned the discrepancy as intended behaviour
// instead of closing it, which is how `brain show` came to display a model the
// process never received. resolveRole now strips a model codex cannot send
// (spec brain-select-four-gaps §3.1); the argv half of the assertion is unchanged.
test("codex: reviewer_model is STRIPPED at resolve, and never reaches argv", async () => {
  const resolved = resolveRole(
    parseBrainConfig(JSON.stringify({ reviewer_provider: "codex", reviewer_model: "gpt-5.5" })),
    "review",
  );
  expect(resolved.family).toBe("codex");
  expect(resolved.model).toBeUndefined();
  // ... and the codex adapter never emits a --model / -m flag either.
  const argv = await argvForConfig(
    JSON.stringify({ reviewer_provider: "codex", reviewer_model: "gpt-5.5" }),
  );
  expect(argv[0]).toBe("codex");
  expect(argv).not.toContain("--model");
  expect(argv).not.toContain("-m");
  expect(argv).not.toContain("gpt-5.5");
});

// AC3, the half that is actually ground truth (spec brain-select-four-gaps).
// `FAMILY_ACCEPTS_MODEL` is a DECLARATION; TypeScript can force a sixth provider
// to fill it in, but nothing in the type system can stop that entry from being
// WRONG. This walks the registry — not a hand-written list — hands each provider
// a model directly (bypassing resolveRole, whose own filter reads the same
// declaration and would make this circular), and checks the declaration against
// the argv the provider really builds. A new provider that declares `true` while
// its argv drops the model fails here.
test("every family's declared model capability matches the argv it really builds", async () => {
  const PROBE = "probe-model-9x";
  expect(FAMILIES.length).toBeGreaterThan(0);

  for (const family of FAMILIES) {
    const sink: { argv?: string[] } = {};
    try {
      await providerForFamily(family).call({
        systemPrompt: "REVIEW RUBRIC",
        contextBundle: "diff --git a/x.ts",
        cwd: "/repo/under/review",
        model: PROBE,
        spawnFn: capturingSpawn(sink),
      });
    } catch {
      // Empty stdout -> parse/exit failure is expected; argv already captured.
    }
    const argv = sink.argv ?? [];
    // Control: the probe must have reached a real spawn, or "no model in argv"
    // would be indistinguishable from "this provider never spawned".
    expect(argv.length).toBeGreaterThan(0);
    expect(argv.includes(PROBE)).toBe(familySupportsModelChoice(family));
  }
});
