/**
 * Doctor — per-role brain health rows (single-brain identity #10, S1).
 *
 * Replaces the old single reviewer-provider row (track #7 T5, AC11 —
 * `checkReviewerProvider`) with three rows, one per BrainRole (chat/review/
 * extract) — see src/cli/doctor-reviewer-check.ts's `checkBrainRoles`. Split
 * from doctor.checks.test.ts to keep that file under the 400-LOC ratchet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRepoRoot, runAllChecks } from "../../src/cli/doctor";
import {
  checkBrainRoles,
  defaultEvalProvenancePath,
  resolveEvalProvenancePath,
} from "../../src/cli/doctor-reviewer-check";
import {
  type DoctorTmp,
  setupDoctorTmp,
  teardownDoctorTmp,
} from "./_doctor-fixtures";

describe("doctor — brain role health rows (chat/review/extract)", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c10-roles-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(env.siltpokeHome, "config.json"), JSON.stringify(config));
  }

  test("wired into runAllChecks as three per-role entries", () => {
    const checks = runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome });
    expect(checks).toHaveLength(14); // the knowledge render-cache row is not in this tree
    const names = checks.map((c) => c.name);
    expect(names).toContain("brain role: chat");
    expect(names).toContain("brain role: review");
    expect(names).toContain("brain role: extract");
  });

  test("default config -> chat/extract silent ✓, review info row with same-family note, none warn", () => {
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(["brain role: chat", "brain role: review", "brain role: extract"]);
    for (const r of rows) {
      expect(r.pass).toBe(true);
      expect(r.status ?? "pass").not.toBe("warn");
    }
    // chat/extract: nothing non-default to say -> silent healthy row (no ◦ noise).
    const chat = rows.find((r) => r.name === "brain role: chat")!;
    const extract = rows.find((r) => r.name === "brain role: extract")!;
    expect(chat.status).toBeUndefined();
    expect(chat.detail).toBeNull();
    expect(extract.status).toBeUndefined();
    expect(extract.detail).toBeNull();
    // review: the one load-bearing signal (cross-family note) stays visible.
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.status).toBe("info");
    expect(review.detail).toContain("same family as author");
    // Slice A T1: the default (claude) review row must flag that review
    // actually defaults to the building host's family at review time, so an
    // out-of-hook claude row isn't misread as "reviews are always claude".
    expect(review.detail).toContain("defaults to the building host's CLI family");
  });

  test("SILTPOKE_REVIEWER_PROVIDER env override reaches the review row end-to-end (doctor-layer regression guard — the old suite's env tests were deleted; env override is otherwise only unit-covered at the pure-parse layer)", () => {
    const prevEnv = process.env.SILTPOKE_REVIEWER_PROVIDER;
    process.env.SILTPOKE_REVIEWER_PROVIDER = "qoder";
    try {
      // No config written — default/empty config; loadBrainConfigSync must
      // still read process.env and override the review role's family.
      const rows = checkBrainRoles({
        siltpokeHome: env.siltpokeHome,
        reviewerWhichFn: () => "/usr/bin/qodercli",
      });
      const chat = rows.find((r) => r.name === "brain role: chat")!;
      const review = rows.find((r) => r.name === "brain role: review")!;
      expect(review.status).toBe("info");
      expect(review.detail).toContain("qoder");
      // chat is unaffected (env override is review-only) -> stays a silent claude row.
      expect(chat.status).toBeUndefined();
      expect(chat.detail).toBeNull();
    } finally {
      if (prevEnv === undefined) delete process.env.SILTPOKE_REVIEWER_PROVIDER;
      else process.env.SILTPOKE_REVIEWER_PROVIDER = prevEnv;
    }
  });

  test("review role on qoder with binary missing -> warn, fail-soft", () => {
    writeConfig({ brain: { roles: { review: { provider: "qoder" } } } });
    const rows = checkBrainRoles({
      siltpokeHome: env.siltpokeHome,
      reviewerWhichFn: () => null, // qodercli absent
    });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.status).toBe("warn");
    expect(review.detail).toContain("qodercli");
  });

  test("review role on qoder gates on the qodercli binary specifically (locks the registry.familyBinary delegation, S2) — a stub answering only 'qodercli' still reads as present", () => {
    writeConfig({ brain: { roles: { review: { provider: "qoder" } } } });
    const rows = checkBrainRoles({
      siltpokeHome: env.siltpokeHome,
      reviewerWhichFn: (cmd) => (cmd === "qodercli" ? "/usr/local/bin/qodercli" : null),
    });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.status).not.toBe("warn");
    expect(review.detail).toContain("binary: ✓ present");
  });

  test("review role on a non-author family shows cross-family ✓", () => {
    writeConfig({ brain: { author_family: "claude", roles: { review: { provider: "qoder" } } } });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome, reviewerWhichFn: () => "/usr/bin/qodercli" });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.detail).toContain("cross-family: ✓");
  });

  test("review role equal to author family shows same-family info note (not warn)", () => {
    writeConfig({ brain: { author_family: "claude", roles: { review: { provider: "claude" } } } });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.detail).toContain("same family as author");
    expect(review.status ?? "pass").not.toBe("warn");
  });

  test("chat/extract rows never show a cross-family note (review-only facet)", () => {
    writeConfig({ brain: { roles: { chat: { provider: "codex" }, extract: { provider: "codex" } } } });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome, reviewerWhichFn: () => "/usr/local/bin/codex" });
    const chat = rows.find((r) => r.name === "brain role: chat")!;
    const extract = rows.find((r) => r.name === "brain role: extract")!;
    expect(chat.detail).not.toContain("cross-family");
    expect(extract.detail).not.toContain("cross-family");
  });

  test("agy review role running a Claude-family model -> warn + cross-family-honesty note (pre-existing agy warn preserved)", () => {
    writeConfig({ brain: { roles: { review: { provider: "agy", model: "Claude Sonnet 4.6 (Thinking)" } } } });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome, reviewerWhichFn: () => "/usr/local/bin/agy" });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.status).toBe("warn");
    expect(review.detail).toContain("not a true cross-family review");
  });

  test("agy CHAT/EXTRACT role running a Claude-family model does NOT warn (the cross-family-honesty facet is review-only)", () => {
    writeConfig({
      brain: {
        roles: {
          chat: { provider: "agy", model: "Claude Sonnet 4.6 (Thinking)" },
          extract: { provider: "agy", model: "Claude Sonnet 4.6 (Thinking)" },
        },
      },
    });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome, reviewerWhichFn: () => "/usr/local/bin/agy" });
    const chat = rows.find((r) => r.name === "brain role: chat")!;
    const extract = rows.find((r) => r.name === "brain role: extract")!;
    expect(chat.status).not.toBe("warn");
    expect(extract.status).not.toBe("warn");
    expect(chat.detail).not.toContain("not a true cross-family review");
    expect(extract.detail).not.toContain("not a true cross-family review");
  });

  test("model label falls back to '(CLI default)' when unset for a non-claude family", () => {
    writeConfig({ brain: { roles: { chat: { provider: "codex" } } } });
    const rows = checkBrainRoles({ siltpokeHome: env.siltpokeHome, reviewerWhichFn: () => "/usr/local/bin/codex" });
    const chat = rows.find((r) => r.name === "brain role: chat")!;
    expect(chat.detail).toContain("(CLI default)");
  });

  test("eval-provenance line: a matching-provider verdict on record shows certified + servedModel on the role row", () => {
    writeConfig({ brain: { roles: { review: { provider: "codex" } } } });
    const provenancePath = join(env.tmp, "verdict.provenance.json");
    writeFileSync(
      provenancePath,
      JSON.stringify({ schemaVersion: 1, provider: "codex", servedModel: "gpt-5.1-codex-max", ts: "2026-07-08T00:00:00.000Z" }),
    );
    const rows = checkBrainRoles({
      siltpokeHome: env.siltpokeHome,
      reviewerWhichFn: () => "/usr/local/bin/codex",
      evalProvenancePath: provenancePath,
    });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.detail).toContain("certified");
    expect(review.detail).toContain("gpt-5.1-codex-max");
  });

  test("repoRoot override, no evalProvenancePath -> reads the provenance file under THAT repoRoot (fallback derivation exercised end-to-end)", () => {
    writeConfig({ brain: { roles: { review: { provider: "codex" } } } });
    const provenanceDir = join(env.tmp, "src", "eval", "caller-impact");
    mkdirSync(provenanceDir, { recursive: true });
    writeFileSync(
      join(provenanceDir, "verdict.provenance.json"),
      JSON.stringify({ schemaVersion: 1, provider: "codex", servedModel: "gpt-5.1-codex-max", ts: "2026-07-08T00:00:00.000Z" }),
    );
    const rows = checkBrainRoles({
      siltpokeHome: env.siltpokeHome,
      repoRoot: env.tmp,
      reviewerWhichFn: () => "/usr/local/bin/codex",
      // evalProvenancePath deliberately omitted — must derive from repoRoot.
    });
    const review = rows.find((r) => r.name === "brain role: review")!;
    expect(review.detail).toContain("certified");
    expect(review.detail).toContain("gpt-5.1-codex-max");
  });
});

// ---------------------------------------------------------------------
// Eval-provenance sidecar path helpers — pure, no doctor-check dependency.
// Predate the per-role split (track #7 T5) and survive it unchanged.
// ---------------------------------------------------------------------
describe("doctor — eval-provenance path helpers", () => {
  test("defaultEvalProvenancePath points at src/eval/caller-impact/verdict.provenance.json under repoRoot", () => {
    expect(defaultEvalProvenancePath("/repo")).toBe(
      join("/repo", "src", "eval", "caller-impact", "verdict.provenance.json"),
    );
  });

  test("no repoRoot AND no evalProvenancePath override -> resolveEvalProvenancePath({}) equals defaultEvalProvenancePath(defaultRepoRoot()), NOT a siltpokeRoot()-based path (the previously-masked default branch)", () => {
    const resolved = resolveEvalProvenancePath({});
    expect(resolved).toBe(defaultEvalProvenancePath(defaultRepoRoot()));
    // Sanity: the repo-root-derived path is NOT the same as a ~/.siltpoke
    // runtime-dir-derived path would be — guards against a regression back
    // to the old `defaultEvalProvenancePath(siltpokeRoot())` fallback.
    expect(resolved).toContain(join("src", "eval", "caller-impact", "verdict.provenance.json"));
    expect(resolved).not.toContain(".siltpoke");
  });

  test("resolveEvalProvenancePath: evalProvenancePath override always wins over repoRoot/default", () => {
    expect(resolveEvalProvenancePath({ evalProvenancePath: "/explicit/path.json" })).toBe("/explicit/path.json");
    expect(resolveEvalProvenancePath({ evalProvenancePath: "/explicit/path.json", repoRoot: "/some/repo" })).toBe(
      "/explicit/path.json",
    );
  });
});
