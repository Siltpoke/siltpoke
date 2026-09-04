// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The audit blocks fill in for a review that cites nothing.
 *
 * This pins a CONSEQUENCE of the 2026-08-19 evidence change that nobody set out
 * to build, and that is worth an assertion precisely because it was noticed by
 * looking at a real page rather than by design:
 *
 * Blocks A / C / D on `/timeline` render from the v2 sidecar. The sidecar is
 * joined to a row by `critique_id`, and `critic-event-log.ts` skips the lookup
 * outright when a row has none ("Legacy entry: no critique_id — skip sidecar to
 * avoid wrong mapping"). `critique_id` is minted only when the critique is
 * FILED. So before this change, a review the guard rejected — 56.5% of them —
 * was never filed, never got an id, and its three audit blocks were empty
 * forever. Not because Siltpoke read nothing: it read plenty, and
 * `writeV2Archive` sat two lines past the `return` that discarded the review.
 *
 * the maintainer asked the right question at a real dashboard — "怎么会什么都没有
 * read" — and the answer is that the reading was thrown away with the review.
 *
 * NORMAL now always files, so it always mints an id, so the sidecar write is
 * always reached. This test drives the exact case that used to die (empty
 * `evidence`) and asserts a sidecar lands on disk.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCritic, type RunCriticDeps, type RunCriticOpts } from "../../src/critic/run-critic";
import type { BrainCallResult } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import type { ToolResult } from "../../src/critic/tools/types";

let tmp: string;
let stateBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-v2sidecar-"));
  stateBase = join(tmp, ".siltpoke");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SNIPPET = "let x: string = badValue;";

function toolsWithFinding(): Awaited<ReturnType<typeof import("../../src/critic/tools/run-tools").runTools>> {
  const na = (tool: "eslint" | "git-diff" | "ripgrep"): ToolResult =>
    ({ tool, status: "not_applicable", parsed: [], raw: "" }) as ToolResult;
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        { file: "src/foo.ts", line: 10, col: 5, severity: "error", code: "TS2322", message: "Type mismatch." },
      ],
      raw: `src/foo.ts(10,5): error TS2322: Type mismatch.\n${SNIPPET}`,
    },
    eslint: na("eslint"),
    "git-diff": na("git-diff"),
    ripgrep: na("ripgrep"),
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  } as never;
}

function caps(): ProjectCapabilities {
  return {
    cwd: tmp,
    hasGit: false,
    hasTsc: true,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: 0,
    configMtimes: {},
  };
}

function brainOut(evidence: BrainOutput["evidence"]): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "found a god-file and a magic number",
    bubble_long: "",
    critique_for_claude: "the rubric really did fire; this is not an empty review",
    severity: "high",
    confidence: "high",
    xp_earned_events: [],
    evidence,
  };
}

function opts(): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: tmp,
    changedFiles: ["src/foo.ts"],
    caps: caps(),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-v2sidecar",
      cwd: tmp,
      stateBase,
    },
  } as RunCriticOpts;
}

async function sidecarsUnder(base: string): Promise<string[]> {
  const archive = join(base, "critiques", "archive");
  const out: string[] = [];
  let days: string[] = [];
  try {
    days = await readdir(archive);
  } catch {
    return out;
  }
  for (const day of days) {
    let files: string[] = [];
    try {
      files = await readdir(join(archive, day));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".v2.md")) out.push(join(day, f));
  }
  return out;
}

function deps(evidence: BrainOutput["evidence"]): RunCriticDeps {
  return {
    runToolsFn: async () => toolsWithFinding(),
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: brainOut(evidence),
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 10,
        output_tokens: 10,
        total_cost_usd: 0,
      },
    }),
    // NOT stubbed away: the real `writeCritique` is what mints the id that the
    // sidecar is named after, and the id is the whole point of this test.
  };
}

test("a review that cites NOTHING still writes its v2 sidecar — the audit blocks fill in", async () => {
  // The exact shape that used to be 53.5% of all silence.
  const result = await runCritic(opts(), deps([]));

  expect(result.decision).toBe("NORMAL");
  if (result.decision !== "NORMAL") return;
  expect(result.evidenceLabel).toBe("no_evidence");

  // The id — without this there is nothing for the timeline to join on, and
  // `attachV2Sidecars` skips the lookup by design.
  expect(result.critiqueId).toBeTruthy();

  // `writeV2Archive` is fire-and-forget (`void ....catch()`), so reading the
  // directory the instant `runCritic` returns is a race, not a measurement.
  await new Promise((r) => setTimeout(r, 300));
  const sidecars = await sidecarsUnder(stateBase);
  expect(sidecars.length).toBeGreaterThan(0);
  // Named after the id, so the join actually resolves.
  expect(sidecars.some((p) => p.includes(`${result.critiqueId}.v2.md`))).toBe(true);
});

test("a review whose only citation is fabricated also keeps its sidecar", async () => {
  // The other 3.0%. Same expectation: the bad quote is dropped, the record is not.
  const result = await runCritic(
    opts(),
    deps([{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: "this snippet was hallucinated by the LLM" }]),
  );

  expect(result.decision).toBe("NORMAL");
  if (result.decision !== "NORMAL") return;
  expect(result.evidenceLabel).toBe("none_verified");
  expect(result.critique.evidence).toEqual([]); // the citation is still refused
  expect(result.critiqueId).toBeTruthy();

  // `writeV2Archive` is fire-and-forget (`void ....catch()`), so reading the
  // directory the instant `runCritic` returns is a race, not a measurement.
  await new Promise((r) => setTimeout(r, 300));
  const sidecars = await sidecarsUnder(stateBase);
  expect(sidecars.some((p) => p.includes(`${result.critiqueId}.v2.md`))).toBe(true);
});
