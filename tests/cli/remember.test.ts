import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inferMemoryType,
  parseInferredType,
  parseRememberArgs,
  type RememberType,
  runRemember,
} from "../../src/cli/remember";
import { emptyMemory, readMemory, writeMemory } from "../../src/memory/memory";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-remember-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date("2026-05-16T10:00:00Z");
const NOW_ISO = NOW.toISOString();

// Stub inferTypeFn that always returns a fixed type
function stubInfer(t: RememberType) {
  return async (_claim: string) => t;
}

// Stub writeMemory that throws
const throwingWrite: typeof writeMemory = async () => {
  throw new Error("disk full");
};

// Stub readMemory that throws
const throwingRead: typeof readMemory = async () => {
  throw new Error("ENOENT");
};

// ---------------------------------------------------------------------------
// parseRememberArgs unit tests
// ---------------------------------------------------------------------------

test("parseRememberArgs: --type fact + claim", () => {
  const r = parseRememberArgs(["--type", "fact", "user prefers dark mode"]);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.type).toBe("fact");
    expect(r.claim).toBe("user prefers dark mode");
  }
});

test("parseRememberArgs: --type goal + multi-word claim", () => {
  const r = parseRememberArgs(["--type", "goal", "ship", "the", "feature", "by", "Friday"]);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.type).toBe("goal");
    expect(r.claim).toBe("ship the feature by Friday");
  }
});

test("parseRememberArgs: --type constraint", () => {
  const r = parseRememberArgs(["--type", "constraint", "never use React"]);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.type).toBe("constraint");
    expect(r.claim).toBe("never use React");
  }
});

test("parseRememberArgs: no --type, just claim", () => {
  const r = parseRememberArgs(["user likes terse output"]);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.type).toBeUndefined();
    expect(r.claim).toBe("user likes terse output");
  }
});

test("parseRememberArgs: unknown --type value → error", () => {
  const r = parseRememberArgs(["--type", "bogus", "something"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("bogus");
});

test("parseRememberArgs: missing claim after --type → error", () => {
  const r = parseRememberArgs(["--type", "fact"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("missing claim");
});

test("parseRememberArgs: unknown flag → error", () => {
  const r = parseRememberArgs(["--bogus", "something"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("--bogus");
});

test("parseRememberArgs: --type without value → error", () => {
  const r = parseRememberArgs(["--type"]);
  expect(r.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// parseInferredType unit tests (F6)
// ---------------------------------------------------------------------------

describe("parseInferredType", () => {
  test('{ type: "fact" } → "fact"', () => {
    expect(parseInferredType({ type: "fact" })).toBe("fact");
  });

  test('{ type: "goal" } → "goal"', () => {
    expect(parseInferredType({ type: "goal" })).toBe("goal");
  });

  test('{ type: "constraint" } → "constraint"', () => {
    expect(parseInferredType({ type: "constraint" })).toBe("constraint");
  });

  test("null → null (unknown output)", () => {
    expect(parseInferredType(null)).toBeNull();
  });

  test("string → null", () => {
    expect(parseInferredType("fact")).toBeNull();
  });

  test('{ type: "bogus" } → null', () => {
    expect(parseInferredType({ type: "bogus" })).toBeNull();
  });

  test("missing type field → null", () => {
    expect(parseInferredType({ something: "else" })).toBeNull();
  });

  test("empty object → null", () => {
    expect(parseInferredType({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRemember integration tests (DI-seam)
// ---------------------------------------------------------------------------

test("--type fact: fact pushed to facts[], status active, exit 0", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "fact", "user prefers dark mode"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(0);
  expect(messages[0]).toContain("remembered:");
  expect(messages[0]).toContain("user prefers dark mode");
  expect(messages[0]).toContain("type: fact");

  const memory = await readMemory(tmp);
  expect(memory).not.toBeNull();
  const fact = memory?.facts.find((f) => f.text === "user prefers dark mode");
  expect(fact).toBeDefined();
  expect(fact?.status).toBe("active");
  expect(fact?.confidence).toBe(1.0);
  expect(fact?.source_session_id).toBeNull();
  expect(fact?.created_at).toBe(NOW_ISO);
  expect(fact?.last_seen_at).toBe(NOW_ISO);
  expect(fact?.supersedes).toBeNull();
  expect(fact?.retired_reason).toBeNull();
  expect(fact?.pinned).toBe(true);
});

test("--type fact: freshly-created fact carries /remember provenance (stability permanent, learned_from.stream remember)", async () => {
  const code = await runRemember({
    argv: ["--type", "fact", "user asserted constraint"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(0);

  const memory = await readMemory(tmp);
  const fact = memory?.facts.find((f) => f.text === "user asserted constraint");
  expect(fact).toBeDefined();
  expect(fact?.stability).toBe("permanent");
  expect(fact?.learned_from?.stream).toBe("remember");
  expect(fact?.learned_from?.session_id).toBeNull();
  expect(fact?.last_confirmed_at).toBe(NOW_ISO);
  // Provenance recorded so /memory shows a real "Why", not the legacy fallback.
  expect(fact?.save_reason).toBe("you asked me to remember this");
});

test("--type goal: goal pushed to user_profile.goals[], exit 0", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "goal", "ship the feature by Friday"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("goal") },
  });

  expect(code).toBe(0);
  expect(messages[0]).toContain("type: goal");

  const memory = await readMemory(tmp);
  expect(memory).not.toBeNull();
  const goal = memory?.user_profile.goals.find((g) => g.text === "ship the feature by Friday");
  expect(goal).toBeDefined();
  expect(goal?.status).toBe("active");
  expect(goal?.created_at).toBe(NOW_ISO);
  expect(goal?.id).toMatch(/^g-/);
});

test("--type constraint: constraint pushed to user_profile.constraints[], exit 0", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "constraint", "never suggest React for backend"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("constraint") },
  });

  expect(code).toBe(0);
  expect(messages[0]).toContain("type: constraint");

  const memory = await readMemory(tmp);
  expect(memory).not.toBeNull();
  expect(memory?.user_profile.constraints).toContain("never suggest React for backend");
});

test("--type omitted: uses inferTypeFn stub returning 'fact'", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["user prefers terse explanations"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(0);
  const memory = await readMemory(tmp);
  expect(memory?.facts.length).toBe(1);
  expect(memory?.facts[0]?.text).toBe("user prefers terse explanations");
});

test("--type omitted: inferTypeFn returns 'goal' → goal stored", async () => {
  const code = await runRemember({
    argv: ["finish the project"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
    deps: { inferTypeFn: stubInfer("goal") },
  });

  expect(code).toBe(0);
  const memory = await readMemory(tmp);
  expect(memory?.user_profile.goals.length).toBe(1);
});

test("--type omitted: inferTypeFn returns 'constraint' → constraint stored", async () => {
  const code = await runRemember({
    argv: ["avoid jQuery"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
    deps: { inferTypeFn: stubInfer("constraint") },
  });

  expect(code).toBe(0);
  const memory = await readMemory(tmp);
  expect(memory?.user_profile.constraints).toContain("avoid jQuery");
});

test("multi-word claim (as split argv tokens) is joined correctly", async () => {
  const code = await runRemember({
    argv: ["--type", "fact", "word1", "word2", "word3"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(0);
  const memory = await readMemory(tmp);
  const fact = memory?.facts[0];
  expect(fact?.text).toBe("word1 word2 word3");
});

test("fact id appears in output and starts with f-", async () => {
  const messages: string[] = [];
  await runRemember({
    argv: ["--type", "fact", "some claim"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(messages[0]).toMatch(/id: f-[0-9a-f]+/);
});

test("unknown --type bogus → exit 3", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "bogus", "something"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(3);
  expect(messages[0]).toContain("bogus");
});

test("missing claim (just --type fact) → exit 3", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "fact"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(3);
  expect(messages[0]).toContain("missing claim");
});

test("unknown flag --bogus → exit 3", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--bogus", "something"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { inferTypeFn: stubInfer("fact") },
  });

  expect(code).toBe(3);
  expect(messages[0]).toContain("--bogus");
});

test("readMemory throws → exit 1", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "fact", "some claim"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: {
      readMemory: throwingRead,
      inferTypeFn: stubInfer("fact"),
    },
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("read failed");
});

test("writeMemory throws → exit 1", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["--type", "fact", "some claim"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: {
      writeMemory: throwingWrite,
      inferTypeFn: stubInfer("fact"),
    },
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("write failed");
});

test("inferTypeFn throws → exit 1", async () => {
  const messages: string[] = [];
  const code = await runRemember({
    argv: ["some claim without type"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: {
      inferTypeFn: async () => {
        throw new Error("LLM timeout");
      },
    },
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("type inference failed");
});

test("existing memory is preserved — new fact appended not replaced", async () => {
  // Seed an existing fact
  const initial = emptyMemory();
  const existing = {
    ...initial,
    facts: [
      {
        id: "f-existing",
        text: "existing fact",
        source_session_id: null,
        confidence: 0.9,
        status: "active" as const,
        created_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable" as const,
        learned_from: null,
        last_confirmed_at: null,
        expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
      },
    ],
  };
  await writeMemory(tmp, existing);

  await runRemember({
    argv: ["--type", "fact", "new fact"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
    deps: { inferTypeFn: stubInfer("fact") },
  });

  const memory = await readMemory(tmp);
  expect(memory?.facts.length).toBe(2);
  expect(memory?.facts.find((f) => f.id === "f-existing")).toBeDefined();
  expect(memory?.facts.find((f) => f.text === "new fact")).toBeDefined();
});

// ---------------------------------------------------------------------------
// inferMemoryType default seam is role-routed (single-brain S2, task 11) —
// inferMemoryType no longer hardcodes the inline `await import("../brain/
// brain")` + a pinned model string with no homeBase; its `rawBrain` param
// defaults to a lazy callBrainRaw import (direct-caller compat), and
// runRemember's default `inferTypeFn` now wires it through
// `makeRoleRawBrain(opts.homeBase, "extract")`. Mocking the shared
// `role-brain` module is deliberately avoided (bun's `mock.module` leaks
// across test files — see task-6 investigation note in
// tests/memory/extract-facts.test.ts). Instead this exercises the REAL
// (unmocked) chain end-to-end: a `config.json` under a tmp homeBase selects
// the "qoder" family for the extract role, and a throwaway executable named
// `qodercli` is put on PATH so the real (un-injected) subprocess spawn
// resolves to a script this test controls — proving the default seam reads
// `homeBase/config.json` and reaches a NON-claude provider, something the
// old static `callBrainRaw` import (always claude, no homeBase) could never
// do.
// ---------------------------------------------------------------------------

describe("runRemember default inferTypeFn seam (role-routed)", () => {
  test("--type omitted + no deps.inferTypeFn + homeBase config selecting qoder → real qoder path is exercised", async () => {
    const bin = mkdtempSync(join(tmpdir(), "remember-role-bin-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        join(tmp, "config.json"),
        JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }),
      );
      const fakeBin = join(bin, "qodercli");
      writeFileSync(
        fakeBin,
        [
          "#!/usr/bin/env bun",
          'const inner = JSON.stringify({ type: "goal" });',
          'const envelope = { type: "result", subtype: "success", is_error: false, result: inner, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 3 } };',
          "process.stdout.write(JSON.stringify(envelope));",
          "",
        ].join("\n"),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ""}`;

      const code = await runRemember({
        argv: ["user wants to ship the feature"],
        homeBase: tmp,
        now: NOW,
        output: () => undefined,
        // no deps.inferTypeFn — exercises the default seam
      });

      expect(code).toBe(0);
      const memory = await readMemory(tmp);
      expect(memory?.user_profile.goals.length).toBe(1);
      expect(memory?.user_profile.goals[0]?.text).toBe("user wants to ship the feature");
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// inferMemoryType unit test: injected rawBrain fn seam (direct-caller path)
// ---------------------------------------------------------------------------

test("inferMemoryType: uses injected rawBrain fn instead of the inline import", async () => {
  let calledWith: unknown;
  const fakeRawBrain = async (opts: { systemPrompt: string; contextBundle: string }) => {
    calledWith = opts;
    return { output: { type: "constraint" }, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 } };
  };

  const result = await inferMemoryType("never use jQuery", fakeRawBrain);

  expect(result).toBe("constraint");
  expect(calledWith).toBeDefined();
  expect((calledWith as { contextBundle: string }).contextBundle).toContain("never use jQuery");
  // model must NOT be set by inferMemoryType itself — the caller-supplied
  // rawBrain (makeRoleRawBrain in production) owns model resolution now.
  expect((calledWith as { model?: string }).model).toBeUndefined();
});
