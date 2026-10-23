/**
 * Defect [50]: a checker that did not run must reach the reviewer as NOT RUN
 * with its reason — never as, or next to, wording that reads as "clean".
 *
 * Found in the field: a project with no tsconfig.json had an obvious type error
 * reviewed as "clean, high confidence" because the reviewer's input said
 * "All linters ... came back clean" while tsc had not run at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPassiveBubblePrompt, buildToolOutputSection } from "../../src/brain/prompt-tools";
import { moodEnum } from "../../src/brain/schema";
import { runEslint } from "../../src/critic/tools/run-eslint";
import { runTools } from "../../src/critic/tools/run-tools";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

const ok = <T extends ToolName>(tool: T): ToolResult =>
  ({ tool, status: "ok", parsed: [], raw: "" }) as ToolResult;
const notRun = (tool: ToolName, status: ToolResult["status"], reason?: string): ToolResult =>
  ({ tool, status, parsed: [], raw: "", ...(reason ? { reason } : {}) }) as ToolResult;

const diffHunk = {
  file: "src/a.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
  header: "@@ -1 +1 @@", body: "-const a = 1;\n+const a: number = 'x';",
};
const diffOk = (): ToolResult =>
  ({ tool: "git-diff", status: "ok", parsed: [diffHunk], raw: "" }) as ToolResult;

function results(over: Partial<Record<ToolName, ToolResult>>): Record<ToolName, ToolResult> {
  return {
    tsc: ok("tsc"), eslint: ok("eslint"), "git-diff": diffOk(), ripgrep: ok("ripgrep"), ...over,
  };
}

describe("tool section (normal path)", () => {
  test("(a) tsc ran with 0 errors: says clean for tsc, no NOT RUN", () => {
    const { section } = buildToolOutputSection(results({}));
    expect(section).toContain("### tsc — clean (no findings)");
    expect(section).not.toContain("NOT RUN");
  });

  test("(b) tsc skipped, no tsconfig: NOT RUN + reason, and tsc is never called clean", () => {
    const { section } = buildToolOutputSection(
      results({ tsc: notRun("tsc", "not_applicable", "no tsconfig.json found") }),
    );
    expect(section).toContain("NOT RUN");
    expect(section).toContain("tsc (no tsconfig.json found)");
    expect(section).not.toContain("tsc — clean");
    expect(section).not.toContain("### tsc");
    // The ran tools are still allowed to say clean.
    expect(section).toContain("### eslint — clean (no findings)");
  });

  test("(c) tsc binary missing: NOT RUN + a not-installed reason", () => {
    const { section } = buildToolOutputSection(results({ tsc: notRun("tsc", "not_installed") }));
    expect(section).toContain("NOT RUN");
    expect(section).toContain("tsc (not installed or could not be started)");
    expect(section).not.toContain("tsc — clean");
  });

  test("timeout and crash are reported as NOT RUN, not as findings-free", () => {
    const { section } = buildToolOutputSection(
      results({ tsc: notRun("tsc", "timeout"), eslint: notRun("eslint", "error") }),
    );
    expect(section).toContain("tsc (timed out before finishing)");
    expect(section).toContain("eslint (crashed or failed to run)");
    expect(section).not.toContain("tsc — clean");
    expect(section).not.toContain("eslint — clean");
  });

  test("(d) every tool skipped: no 'clean' anywhere, no 'Tools ran'", () => {
    const { section } = buildToolOutputSection({
      tsc: notRun("tsc", "not_applicable", "no tsconfig.json found"),
      eslint: notRun("eslint", "not_applicable", "no eslint config file found"),
      "git-diff": notRun("git-diff", "not_applicable"),
      ripgrep: notRun("ripgrep", "not_installed"),
    });
    expect(section).toContain("NOT RUN");
    expect(section).not.toContain("clean (no findings)");
    expect(section).not.toContain("— clean");
    expect(section).not.toContain("Tools ran");
  });
});

describe("passive-bubble prompt (the path that said 'all linters clean')", () => {
  const base = { files: 1, hunks: 1 };

  test("both linters and rg ran: legacy clean wording is unchanged", () => {
    const p = buildPassiveBubblePrompt({
      ...base, checks: { tsc: ok("tsc"), eslint: ok("eslint"), ripgrep: ok("ripgrep") },
    });
    expect(p).toContain("All linters and the search-for-issues pass came back clean.");
    expect(p).not.toContain("NOT RUN");
  });

  test("tsc + eslint not run (no tsconfig / no config): NOT RUN with reasons, never 'clean'", () => {
    const p = buildPassiveBubblePrompt({
      ...base,
      checks: {
        tsc: notRun("tsc", "not_applicable", "no tsconfig.json found"),
        eslint: notRun("eslint", "not_applicable", "no eslint config file found"),
        ripgrep: ok("ripgrep"),
      },
    });
    expect(p).toContain("NOT RUN: tsc (no tsconfig.json found), eslint (no eslint config file found)");
    expect(p).toContain("Ran and found nothing: ripgrep.");
    expect(p).not.toMatch(/came back clean|happy-mood|clean work/);
    expect(p).not.toContain("All linters");
  });

  test("tsc binary missing but eslint ran: only tsc is listed as not run", () => {
    const p = buildPassiveBubblePrompt({
      ...base,
      checks: { tsc: notRun("tsc", "not_installed"), eslint: ok("eslint"), ripgrep: ok("ripgrep") },
    });
    expect(p).toContain("NOT RUN: tsc (not installed or could not be started).");
    expect(p).toContain("Ran and found nothing: eslint, ripgrep.");
    expect(p).not.toContain("NOT RUN: tsc (not installed or could not be started), eslint");
  });

  test("nothing ran: says no checker produced a result", () => {
    const p = buildPassiveBubblePrompt({
      ...base,
      checks: { tsc: notRun("tsc", "timeout"), eslint: notRun("eslint", "error"), ripgrep: notRun("ripgrep", "not_installed") },
    });
    expect(p).toContain("No checker produced a result.");
    expect(p).not.toContain("came back clean");
  });
});

describe("scheduler records WHY a tool did not run", () => {
  test("no tsconfig + no eslint config: reasons are set on the results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-not-run-"));
    try {
      const r = await runTools({
        cwd: dir,
        changedFiles: [join(dir, "a.ts")],
        caps: {
          cwd: dir, hasGit: false, hasTsc: true, hasEslint: true, hasRipgrep: false,
          tsconfigPaths: [], eslintConfigPaths: [], detectedAt: 0, configMtimes: {},
        },
      });
      expect(r.tsc.status).toBe("not_applicable");
      expect((r.tsc as { reason?: string }).reason).toBe("no tsconfig.json found");
      expect((r.eslint as { reason?: string }).reason).toBe("no eslint config file found");
      expect(buildToolOutputSection(r).section).toContain("tsc (no tsconfig.json found)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NOT RELEVANT is not NOT RUN", () => {
  const irrelevant = (tool: ToolName, reason: string): ToolResult =>
    ({ tool, status: "not_applicable", parsed: [], raw: "", reason, notRelevant: true }) as ToolResult;

  test("docs-only change: header lists them as not relevant, never as NOT RUN", () => {
    const { section } = buildToolOutputSection(
      results({
        tsc: irrelevant("tsc", "no .ts/.tsx file changed"),
        eslint: irrelevant("eslint", "no JS/TS file changed"),
      }),
    );
    expect(section).toContain("**Not relevant to this change:** tsc (no .ts/.tsx file changed), eslint (no JS/TS file changed)");
    expect(section).not.toContain("NOT RUN");
  });

  test("docs-only change: passive prompt is the old happy prompt, byte for byte", () => {
    const legacy = buildPassiveBubblePrompt({ files: 1, hunks: 1 });
    const p = buildPassiveBubblePrompt({
      files: 1,
      hunks: 1,
      checks: {
        tsc: irrelevant("tsc", "no .ts/.tsx file changed"),
        eslint: irrelevant("eslint", "no JS/TS file changed"),
        ripgrep: ok("ripgrep"),
      },
    });
    expect(p).toBe(legacy);
    expect(p).toContain("All linters and the search-for-issues pass came back clean.");
  });

  test("a relevant-but-missing tsc next to an irrelevant eslint still triggers NOT RUN, only for tsc", () => {
    const p = buildPassiveBubblePrompt({
      files: 1,
      hunks: 1,
      checks: {
        tsc: notRun("tsc", "not_applicable", "no tsconfig.json found"),
        eslint: irrelevant("eslint", "no JS/TS file changed"),
        ripgrep: ok("ripgrep"),
      },
    });
    expect(p).toContain("NOT RUN: tsc (no tsconfig.json found).");
    expect(p).not.toContain("eslint (");
  });

  test("not-run passive prompt names a valid mood and forbids high confidence", () => {
    const p = buildPassiveBubblePrompt({
      files: 1,
      hunks: 1,
      checks: { tsc: notRun("tsc", "timeout"), eslint: ok("eslint"), ripgrep: ok("ripgrep") },
    });
    expect(moodEnum.safeParse("watching").success).toBe(true);
    expect(p).toContain('mood "watching"');
    expect(p).toContain("do not claim high confidence");
  });

  test("runEslint with no files is NOT RELEVANT; all-unsafe paths are NOT RUN", async () => {
    const none = await runEslint({ cwd: tmpdir(), changedFiles: [] });
    expect(none).toMatchObject({ status: "not_applicable", notRelevant: true });
    const unsafe = await runEslint({ cwd: tmpdir(), changedFiles: ["src/--inspect"] });
    expect(unsafe.status).toBe("not_applicable");
    expect(unsafe.reason).toContain("unsafe");
    expect(unsafe.notRelevant).toBeUndefined();
  });

  test("runTools: docs-only change marks tsc and eslint not relevant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-not-rel-"));
    try {
      const r = await runTools({
        cwd: dir,
        changedFiles: [join(dir, "README.md")],
        caps: {
          cwd: dir, hasGit: false, hasTsc: true, hasEslint: true, hasRipgrep: false,
          tsconfigPaths: [], eslintConfigPaths: [], detectedAt: 0, configMtimes: {},
        },
      });
      expect((r.tsc as { notRelevant?: boolean }).notRelevant).toBe(true);
      expect((r.eslint as { notRelevant?: boolean }).notRelevant).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
