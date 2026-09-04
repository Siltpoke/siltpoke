// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * INDEPENDENT acceptance test — track #7 T5 (doctor row + eval codex arm).
 *
 * Spec: an internal design note
 * Covers: AC11 (doctor gains a reviewer-provider row) + AC12 (eval codex arm,
 * dry-run only — no real spawns, no --execute).
 *
 * AC11 driving surface: the REAL `runAllChecks` (src/cli/doctor.ts) via its
 * public `DoctorOptions` injection seams — `siltpokeHome`, `reviewerWhichFn`,
 * `evalProvenancePath` — rather than calling `checkBrainRoles` directly
 * (that's the unit test's job, tests/cli/doctor-reviewer-check.test.ts). This
 * file drives the check the way the real CLI entry point does: locating the
 * "brain role: review" row BY NAME in runAllChecks()'s array (single-brain
 * #10 S1 replaced the old single reviewer-provider row with three per-role
 * rows — chat/review/extract — so a fixed index is no longer stable), and
 * cross-checks its contribution to `formatJson`'s `fail_count`/`all_pass`
 * (the exit-code-deriving arithmetic) using the REAL formatJson function
 * rather than reimplementing the filter.
 *
 * AC12 driving surface: run-eval.ts's `main()` dry-run path (never
 * `--execute`, so zero paid Brain calls/spawns are possible by construction)
 * driven with a small SELF-BUILT manifest via the real `--manifest` flag;
 * `CallCountTracker`/`checkCallGate` (src/eval/caller-impact/cost-gate.ts)
 * driven directly since they are exported, pure, and the task instructions
 * name them as the intended direct-drive seam; `writeVerdictMd`
 * (src/eval/caller-impact/verdict-writer.ts) driven directly (pure,
 * exported) for the "## Provider" section + the provenance object shape,
 * with the sidecar JSON serialized using the EXACT shape main() uses
 * (`{ schemaVersion: 1, ...provenance }`) so the round-trip is checked
 * against the SAME `VerdictProvenanceFile` shape doctor-reviewer-check.ts
 * reads (closing the AC11↔AC12 provenance loop). main()'s actual `--execute`
 * write-through of that sidecar is NOT driven here — reaching it requires a
 * real, INV2-passing frozen manifest (a real paid `codex exec` call), which
 * the task instructions forbid; that exact write-through is independently
 * covered by tests/eval/caller-impact/run-eval-provider.test.ts's
 * "provenance sidecar write-through" describe block, cited below instead of
 * duplicated. Release-gate doc thresholds are asserted grep-level per the
 * task instructions ("grep-level assertions are fine for the doc").
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckResult, formatJson, runAllChecks } from "../../src/cli/doctor";
import {
  CallCeilingExceeded,
  CallCountTracker,
  checkCallGate,
} from "../../src/eval/caller-impact/cost-gate";
import { computeContentHash, type EvalExample, type EvalManifest } from "../../src/eval/caller-impact/manifest";
import { main, verdictProvenancePathFor } from "../../src/eval/caller-impact/run-eval";
import { runArmsOverSet } from "../../src/eval/caller-impact/runner";
import { type VerdictProvenance, writeVerdictMd } from "../../src/eval/caller-impact/verdict-writer";


// ---------------------------------------------------------------------------
// Shared tmp-dir scaffolding (self-contained — no cross-directory import from
// tests/cli/_doctor-fixtures.ts, keeping this file independent per the
// t1-t4 precedent).
// ---------------------------------------------------------------------------

function makeDoctorTmp(prefix: string): { tmp: string; claudeHome: string; siltpokeHome: string } {
  const tmp = mkdtempSync(join(tmpdir(), `siltpoke-t5-doctor-${prefix}-`));
  const claudeHome = join(tmp, ".claude"); // deliberately NOT created — existsSync-based
  // checks (settings.json etc.) tolerate a missing dir; only the
  // reviewer-provider row's arithmetic is under test here.
  const siltpokeHome = join(tmp, ".siltpoke");
  mkdirSync(siltpokeHome, { recursive: true });
  return { tmp, claudeHome, siltpokeHome };
}

function writeReviewerConfig(siltpokeHome: string, config: Record<string, unknown>): void {
  writeFileSync(join(siltpokeHome, "config.json"), JSON.stringify(config), "utf8");
}

// ---------------------------------------------------------------------------
// AC11 — doctor gains a reviewer-provider row.
// ---------------------------------------------------------------------------

/** Locate the "brain role: review" row — single-brain #10 S1 replaced the
 * old single reviewer-provider row with three per-role rows, so a fixed
 * array index is no longer a stable way to find it (see file header). */
function findReviewRow(results: readonly CheckResult[]): CheckResult {
  const row = results.find((r) => r.name === "brain role: review");
  if (!row) throw new Error('"brain role: review" row not found in runAllChecks() output');
  return row;
}

describe("AC11 — /siltpoke-doctor reviewer-provider row, driven via the real runAllChecks", () => {
  test("(a) default config (reviewer_provider unset) -> review row present, pass=true, family claude, status='info' (S1: every role row — even the healthy default — carries a visible detail line)", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("default");
    try {
      const results = runAllChecks({ claudeHome, siltpokeHome });
      const row = findReviewRow(results);
      expect(row.name).toBe("brain role: review");
      expect(row.pass).toBe(true);
      expect(row.status).toBe("info");
      expect(row.detail).toContain("family: claude");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(b) config codex + binary missing (whichFn -> null) -> status='warn', pass=true; this row's warn NEVER inflates formatJson's fail_count/all_pass (exit-code-deriving logic)", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("codex-missing-binary");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => null,
        evalProvenancePath: join(tmp, "no-such-verdict.provenance.json"),
      });
      const row = findReviewRow(results);
      expect(row.detail).toContain("codex");
      expect(row.status).toBe("warn");
      expect(row.pass).toBe(true);
      expect(row.detail).toContain("not found on PATH");

      // Exit-code-deriving arithmetic: formatJson computes fail_count/all_pass
      // purely from `pass`, over the REAL function, not a hand-rolled filter.
      const json = JSON.parse(formatJson(results)) as {
        all_pass: boolean;
        fail_count: number;
        checks: CheckResult[];
      };
      const expectedFails = results.filter((r) => !r.pass).length;
      expect(json.fail_count).toBe(expectedFails);
      expect(json.all_pass).toBe(expectedFails === 0);
      // The warn row specifically is never among the counted failures, and
      // its `pass` survives the JSON round-trip unchanged.
      expect(findReviewRow(json.checks).pass).toBe(true);
      const failingNames = results.filter((r) => !r.pass).map((r) => r.name);
      expect(failingNames).not.toContain(row.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(c) config codex + binary present -> status='info', detail carries the eval-provenance one-liner (uncertified: no verdict on record)", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("codex-binary-present");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => "/usr/local/bin/codex",
        evalProvenancePath: join(tmp, "no-such-verdict.provenance.json"),
      });
      const row = findReviewRow(results);
      expect(row.status).toBe("info");
      expect(row.pass).toBe(true);
      expect(row.detail).toContain("codex");
      expect(row.detail).toContain("eval:");
      expect(row.detail).toContain("uncertified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(d1) provenance file present with a MATCHING provider -> detail cites servedModel + date", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("provenance-match");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const provenancePath = join(tmp, "verdict.provenance.json");
      writeFileSync(
        provenancePath,
        JSON.stringify({
          schemaVersion: 1,
          provider: "codex",
          servedModel: "gpt-5.1-codex-max",
          ts: "2026-07-08T00:00:00.000Z",
        }),
        "utf8",
      );
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => "/usr/local/bin/codex",
        evalProvenancePath: provenancePath,
      });
      const row = findReviewRow(results);
      expect(row.detail).toContain("certified");
      expect(row.detail).toContain("gpt-5.1-codex-max");
      expect(row.detail).toContain("2026-07-08");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(d2) provenance file ABSENT -> uncertified (already exercised by (b)/(c) above via a nonexistent path; asserted again explicitly here)", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("provenance-absent");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => "/usr/local/bin/codex",
        evalProvenancePath: join(tmp, "definitely-does-not-exist.provenance.json"),
      });
      expect(findReviewRow(results).detail).toContain("uncertified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(d3) provenance file CORRUPT (invalid JSON) -> tolerated as uncertified, runAllChecks never throws", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("provenance-corrupt");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const provenancePath = join(tmp, "verdict.provenance.json");
      writeFileSync(provenancePath, "{ not valid json at all", "utf8");
      expect(() =>
        runAllChecks({
          claudeHome,
          siltpokeHome,
          reviewerWhichFn: () => "/usr/local/bin/codex",
          evalProvenancePath: provenancePath,
        }),
      ).not.toThrow();
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => "/usr/local/bin/codex",
        evalProvenancePath: provenancePath,
      });
      expect(findReviewRow(results).detail).toContain("uncertified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("(d4) provenance file present but for a DIFFERENT provider (claude) -> still uncertified (certification is per-provider)", () => {
    const { claudeHome, siltpokeHome, tmp } = makeDoctorTmp("provenance-wrong-provider");
    try {
      writeReviewerConfig(siltpokeHome, { reviewer_provider: "codex" });
      const provenancePath = join(tmp, "verdict.provenance.json");
      writeFileSync(
        provenancePath,
        JSON.stringify({ schemaVersion: 1, provider: "claude", servedModel: "claude-haiku-4-5", ts: "2026-07-08T00:00:00.000Z" }),
        "utf8",
      );
      const results = runAllChecks({
        claudeHome,
        siltpokeHome,
        reviewerWhichFn: () => "/usr/local/bin/codex",
        evalProvenancePath: provenancePath,
      });
      expect(findReviewRow(results).detail).toContain("uncertified");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC12 — eval codex arm (dry-run only; --execute is NEVER invoked in this
// file, so no real subprocess/spawn is possible by construction).
// ---------------------------------------------------------------------------

describe("AC12 — run-eval.ts dry-run path with --provider codex (real main(), zero paid calls)", () => {
  function buildSmallManifest(n: number): EvalManifest {
    const examples: EvalExample[] = Array.from({ length: n }, (_, i) => ({
      id: `t5-e${i}`,
      repo: "r",
      diff: `diff-${i}`,
      plantedBug: { file: "a.ts", function: "f", line: 1 },
      isControl: false,
    }));
    return { version: "1", examples, contentHash: computeContentHash(examples) };
  }

  let restoreStdout: (() => void) | undefined;
  function captureStdout(): { text: () => string } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    restoreStdout = () => {
      process.stdout.write = original;
    };
    return { text: () => chunks.join("") };
  }

  afterEach(() => {
    restoreStdout?.();
    restoreStdout = undefined;
  });

  test("flag parsing + gate reporting: --provider codex WITHOUT --max-calls (dry-run) reports the examples×arms×repeats default in the call projection (T5 review fix — was the unusable frozen-set-size-alone default)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-t5-ac12-dryrun-"));
    try {
      const manifest = buildSmallManifest(3);
      const manifestPath = join(tmp, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
      const out = captureStdout();

      const code = await main(["--provider", "codex", "--manifest", manifestPath]);

      expect(code).toBe(0);
      const printed = out.text();
      expect(printed).toContain("provider:        codex");
      // buildDryRunPlan's provider line + main()'s gateLines both surface the
      // quota-billed nature; the gate line specifically states the DEFAULT
      // ceiling — examples × arms × repeats (4 arms, --repeats omitted = 1) —
      // that will apply when --max-calls is omitted at --execute time. This
      // replaces the old `default = frozen-set size, <N>` assertion: that
      // default (example count alone) was always < examples×arms×repeats,
      // so checkCallGate refused every unadorned default run — the T5
      // review's fix 3.
      expect(printed).toContain("quota-billed");
      expect(printed).toContain(
        `default = examples × arms × repeats = ${manifest.examples.length} × 4 × 1 = ${manifest.examples.length * 4 * 1}`,
      );
      expect(printed).toContain("NOT RUN");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dry-run defaults to claude (unchanged) when --provider is omitted — no quota-billed / frozen-set-size language leaks in", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-t5-ac12-dryrun-claude-"));
    try {
      const manifest = buildSmallManifest(2);
      const manifestPath = join(tmp, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
      const out = captureStdout();

      const code = await main(["--manifest", manifestPath]);

      expect(code).toBe(0);
      const printed = out.text();
      expect(printed).toContain("provider:        claude");
      expect(printed).not.toContain("quota-billed");
      expect(printed).toContain("projected arm spend");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("main(['--execute', '--provider', 'codex']) against a nonexistent manifest refuses before any paid call (return code 1, no manifest = no spawn possible)", async () => {
    const code = await main([
      "--execute",
      "--provider",
      "codex",
      "--max-calls",
      "5",
      "--manifest",
      "/nonexistent/t5-frozen-manifest.json",
    ]);
    expect(code).toBe(1);
  });
});

describe("AC12 — CallCountTracker / checkCallGate driven directly (exported, pure)", () => {
  test("checkCallGate: no ceiling given -> refused with 'no call ceiling' reason", () => {
    const gate = checkCallGate(10, undefined);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("no call ceiling");
  });

  test("checkCallGate: ceiling <= 0 -> refused", () => {
    const gate = checkCallGate(10, 0);
    expect(gate.ok).toBe(false);
  });

  test("checkCallGate: estimated calls exceed the ceiling -> refused, reason names both numbers", () => {
    const gate = checkCallGate(12, 5);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("12");
    expect(gate.reason).toContain("5");
  });

  test("checkCallGate: estimated calls within the ceiling -> ok", () => {
    const gate = checkCallGate(5, 12);
    expect(gate.ok).toBe(true);
  });

  test("CallCountTracker: add() past the ceiling throws CallCeilingExceeded, with callsMade/ceilingCalls on the error", () => {
    const tracker = new CallCountTracker(3);
    tracker.add();
    tracker.add();
    tracker.add();
    expect(tracker.callsMade).toBe(3);
    let thrown: unknown;
    try {
      tracker.add();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CallCeilingExceeded);
    const err = thrown as CallCeilingExceeded;
    expect(err.callsMade).toBe(4);
    expect(err.ceilingCalls).toBe(3);
    expect(err.message).toContain("call ceiling exceeded");
  });
});

describe("AC12 — verdict-writer VerdictProvenance -> '## Provider' section + provenance sidecar shape (pure functions, no main()/--execute)", () => {
  test("writeVerdictMd with a codex VerdictProvenance -> body contains '## Provider' + provider/servedModel/run-completed lines; report.provenance echoes the input", async () => {
    const examples: EvalExample[] = [
      { id: "t5-verdict-e1", repo: "r", diff: "d", plantedBug: { file: "a.ts", function: "f", line: 1 }, isControl: false },
    ];
    const manifest: EvalManifest = { version: "1", examples, contentHash: computeContentHash(examples) };
    const results = await runArmsOverSet(manifest, async () => []);
    const provenance: VerdictProvenance = {
      provider: "codex",
      servedModel: "gpt-5.1-codex-max",
      ts: "2026-07-08T00:00:00.000Z",
    };

    const report = writeVerdictMd(results, undefined, provenance);

    expect(report.body).toContain("## Provider");
    expect(report.body).toContain("- provider: codex");
    expect(report.body).toContain("- servedModel: gpt-5.1-codex-max");
    expect(report.body).toContain("- run completed: 2026-07-08T00:00:00.000Z");
    expect(report.provenance).toEqual(provenance);
  });

  test("writeVerdictMd WITHOUT a provenance arg (claude/default path) -> no '## Provider' section at all, report.provenance is undefined (byte-identical to pre-T5 verdict.md)", async () => {
    const examples: EvalExample[] = [
      { id: "t5-verdict-e2", repo: "r", diff: "d", plantedBug: { file: "a.ts", function: "f", line: 1 }, isControl: false },
    ];
    const manifest: EvalManifest = { version: "1", examples, contentHash: computeContentHash(examples) };
    const results = await runArmsOverSet(manifest, async () => []);

    const report = writeVerdictMd(results);

    expect(report.body).not.toContain("## Provider");
    expect(report.provenance).toBeUndefined();
  });

  test("provenance sidecar round-trips through the EXACT shape main() serializes ({schemaVersion:1, ...provenance}) and the EXACT shape doctor-reviewer-check.ts's VerdictProvenanceFile reads", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-t5-ac12-provenance-"));
    try {
      const examples: EvalExample[] = [
        { id: "t5-verdict-e3", repo: "r", diff: "d", plantedBug: { file: "a.ts", function: "f", line: 1 }, isControl: false },
      ];
      const manifest: EvalManifest = { version: "1", examples, contentHash: computeContentHash(examples) };
      const results = await runArmsOverSet(manifest, async () => []);
      const provenance: VerdictProvenance = {
        provider: "codex",
        servedModel: "gpt-5.1-codex-max",
        ts: "2026-07-08T00:00:00.000Z",
      };
      const report = writeVerdictMd(results, undefined, provenance);

      const verdictPath = join(tmp, "verdict.md");
      const provenancePath = verdictProvenancePathFor(verdictPath);
      writeFileSync(verdictPath, report.body, "utf8");
      // Same serialization main() performs at its --execute writeFileSync
      // call site (run-eval.ts) — reproduced here since driving main() to
      // that exact line requires a real paid --execute run (forbidden).
      writeFileSync(
        provenancePath,
        `${JSON.stringify({ schemaVersion: 1, ...report.provenance }, null, 2)}\n`,
        "utf8",
      );

      expect(provenancePath).toBe(join(tmp, "verdict.provenance.json"));
      const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as {
        schemaVersion: number;
        provider: string;
        servedModel: string;
        ts: string;
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.provider).toBe("codex");
      expect(parsed.servedModel).toBe("gpt-5.1-codex-max");
      expect(parsed.ts).toBe("2026-07-08T00:00:00.000Z");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

