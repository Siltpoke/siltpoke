// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect ⑩ step 1, end of the wire: run the real critic pipeline against the
 * REAL `writeCritique` and read the file it leaves on disk.
 *
 * Every other test of this change stops one step short. `tests/state/
 * critique.test.ts` calls `writeCritique` directly — it proves the writer
 * renders correctly, and says nothing about whether the critic ever hands it a
 * verdict. `run-critic.golden.test.ts` captures the `CritiqueInput` the
 * pipeline builds — it proves the argument is assembled, but its
 * `writeCritiqueFn` is a stub, so the real writer is never called on this path.
 * Both were green while the two could have disagreed completely.
 *
 * So this file stubs only what must be stubbed to stay deterministic and
 * offline — the tools and the Brain call — and lets everything downstream run
 * for real, ending at `readFileSync` on the path the pipeline itself returned.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCritic, type RunCriticDeps, type RunCriticOpts } from "../../src/critic/run-critic";
import { writeCritique } from "../../src/state/critique";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import type { BrainOutput } from "../../src/brain/schema";
import type { BrainCallResult } from "../../src/brain/brain";

let tmp: string;

beforeEach(() => {
  // Not under ~/Documents — reading fixtures out of an iCloud-synced path
  // stalls for tens of seconds and surfaces as a subprocess timeout.
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-evidence-wire-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Appears verbatim in the tsc raw output below, so the guard can confirm it. */
const REAL_SNIPPET = "let x: string = badValue;";
/** Appears nowhere in any tool output — the guard must refuse it. */
const FABRICATED = "this snippet was never in any tool output";

function caps(cwd: string): ProjectCapabilities {
  return {
    cwd,
    hasGit: true,
    hasTsc: true,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: 0,
    configMtimes: {},
  };
}

function opts(cwd: string, stateBase: string): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd,
    changedFiles: ["src/foo.ts"],
    caps: caps(cwd),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke (fixture).",
      memory: null,
      recent: [],
      sessionId: "sess-evidence-wire",
      cwd,
      stateBase,
    },
  };
}

function brainOut(evidence: BrainOutput["evidence"]): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "Found a type error",
    bubble_long: "You have a type mismatch in foo.ts.",
    critique_for_claude: "src/foo.ts line 10 has a type error.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence,
  };
}

/** Tools + Brain are the only stubs. Everything after them runs for real. */
function deps(out: BrainOutput): RunCriticDeps {
  return {
    runToolsFn: async () => ({
      tsc: {
        tool: "tsc",
        status: "ok",
        parsed: [
          {
            file: "src/foo.ts",
            line: 10,
            col: 5,
            severity: "error",
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
          },
        ],
        raw: `src/foo.ts(10,5): error TS2322: Type 'number' is not assignable.\n${REAL_SNIPPET}`,
      },
      eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
      "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
      ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    }),
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: out,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
        total_cost_usd: 0.001,
      },
    }),
    // The real writer. This is the whole point of the file.
    writeCritiqueFn: writeCritique,
  };
}

/** Locate the file the pipeline actually wrote, via its own returned id. */
function readWritten(stateBase: string, id: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return readFileSync(join(stateBase, "critiques", "archive", day, `${id}.md`), "utf8");
}

test("a confirmed citation survives the whole pipeline onto disk", async () => {
  const stateBase = join(tmp, ".siltpoke");
  const result = await runCritic(
    opts(join(tmp, "proj"), stateBase),
    deps(brainOut([{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: REAL_SNIPPET }])),
  );

  expect(result.decision).toBe("NORMAL");
  const id = "critiqueId" in result ? result.critiqueId : undefined;
  expect(id).toBeDefined();

  const md = readWritten(stateBase, id!);
  expect(md).toContain("evidence_label: verified");
  expect(md).toContain("### Confirmed");
  expect(md).toContain("src/foo.ts:10");
  expect(md).toContain(REAL_SNIPPET);
});

test("a refused citation reaches disk with the guard's reason, not just a count", async () => {
  const stateBase = join(tmp, ".siltpoke");
  const result = await runCritic(
    opts(join(tmp, "proj"), stateBase),
    deps(brainOut([{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: FABRICATED }])),
  );

  expect(result.decision).toBe("NORMAL");
  const id = "critiqueId" in result ? result.critiqueId : undefined;
  const md = readWritten(stateBase, id!);

  expect(md).toContain("evidence_label: none_verified");
  expect(md).toContain("### Refused");
  // The reason, not merely the fact. A count cannot say WHICH one went or why,
  // and reconstructing that from the archive is what step 2 has to do.
  expect(md).toContain("snippet not in evidence_corpus");
  expect(md).toContain("#0");
  // Where the refused citation pointed — carried through the guard because the
  // caller has already overwritten `critique.evidence` by the time this is
  // written, so `index` alone points into an array the reader cannot see.
  expect(md).toContain("src/foo.ts:10");

  // And the fabricated text must NOT be filed as evidence — the guard drops the
  // citation while keeping the review. `escapeForFence` handles the fence; this
  // asserts the item never reaches the Confirmed list at all.
  expect(md).not.toContain("### Confirmed\n\n- `src/foo.ts:10`");
});

test("history.jsonl records what the pipeline actually confirmed", async () => {
  const stateBase = join(tmp, ".siltpoke");
  await runCritic(
    opts(join(tmp, "proj"), stateBase),
    deps(brainOut([{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: FABRICATED }])),
  );

  const line = readFileSync(join(stateBase, "critiques", "history.jsonl"), "utf8").trim();
  const parsed = JSON.parse(line);
  expect(parsed.evidence_label).toBe("none_verified");
  expect(parsed.evidence_cited).toBe(1);
  // Zero, because the guard refused it — the field that used to fall back to
  // the cited count and report this as confirmed.
  expect(parsed.evidence_verified).toBe(0);
  expect(parsed.evidence_unverified).toBe(1);
});
