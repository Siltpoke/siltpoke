import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTools } from "../../../src/critic/tools/run-tools";
import type { ProjectCapabilities } from "../../../src/critic/capabilities";
import { Tracer } from "../../../src/observability/tracer";
import type { Span } from "../../../src/observability/types";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-runtools-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCaps(overrides: Partial<ProjectCapabilities> = {}): ProjectCapabilities {
  return {
    cwd: tmp,
    hasGit: false,
    hasTsc: false,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: Date.now(),
    configMtimes: {},
    ...overrides,
  };
}

async function initGitRepo(dir: string) {
  const { spawnWithTimeout } = await import("../../../src/critic/spawn");
  await spawnWithTimeout({ argv: ["git", "init"], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({ argv: ["git", "config", "user.email", "test@test.com"], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({ argv: ["git", "config", "user.name", "Test"], cwd: dir, timeoutMs: 5000 });
  // Create and commit an initial file
  writeFileSync(join(dir, "init.ts"), "const init = 1;\n");
  await spawnWithTimeout({ argv: ["git", "add", "."], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({
    argv: ["git", "commit", "-m", "init"],
    cwd: dir,
    timeoutMs: 5000,
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00", GIT_COMMITTER_DATE: "2024-01-01T00:00:00" } as Record<string, string>,
  });
}

describe("runTools aggregator", () => {
  test("no caps → tsc/eslint/git-diff return not_applicable; ripgrep always runs", async () => {
    const caps = makeCaps();
    const result = await runTools({ cwd: tmp, changedFiles: [], caps });

    expect(result.tsc.status).toBe("not_applicable");
    expect(result.eslint.status).toBe("not_applicable");
    expect(result["git-diff"].status).toBe("not_applicable");
    // ripgrep is always scheduled — will be ok, not_installed, or error depending on env
    expect(["ok", "not_installed", "error"]).toContain(result.ripgrep.status);
  });

  test("all four keys always present in result", async () => {
    const caps = makeCaps();
    const result = await runTools({ cwd: tmp, changedFiles: [], caps });

    expect(result).toHaveProperty("tsc");
    expect(result).toHaveProperty("eslint");
    expect(result).toHaveProperty("git-diff");
    expect(result).toHaveProperty("ripgrep");
    expect(result.tsc.tool).toBe("tsc");
    expect(result.eslint.tool).toBe("eslint");
    expect(result["git-diff"].tool).toBe("git-diff");
    expect(result.ripgrep.tool).toBe("ripgrep");
  });

  test("caps.hasGit=true → git-diff is scheduled (not not_applicable)", async () => {
    await initGitRepo(tmp);
    const caps = makeCaps({ hasGit: true });

    const result = await runTools({ cwd: tmp, changedFiles: [], caps });

    // git-diff should be scheduled and return ok (no changes in clean repo)
    expect(result["git-diff"].status).toBe("ok");
    expect(result.tsc.status).toBe("not_applicable");
    expect(result.eslint.status).toBe("not_applicable");
    // ripgrep is always scheduled — status depends on whether rg is in PATH
    expect(["ok", "not_installed", "error"]).toContain(result.ripgrep.status);
  });

  test("caps missing tsc → tsc returns not_applicable even with .ts changed files", async () => {
    const caps = makeCaps({ hasTsc: false });
    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "foo.ts")],
      caps,
    });

    expect(result.tsc.status).toBe("not_applicable");
  });

  test("caps missing eslint → eslint returns not_applicable", async () => {
    const caps = makeCaps({ hasEslint: false });
    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "foo.ts")],
      caps,
    });

    expect(result.eslint.status).toBe("not_applicable");
  });

  test("non-git cwd + hasGit=true → git-diff returns not_applicable (runtime error)", async () => {
    // caps says hasGit=true but tmp is not actually a git repo
    // git-diff should return not_applicable (not a git repository)
    const caps = makeCaps({ hasGit: true });
    const result = await runTools({ cwd: tmp, changedFiles: [], caps });

    expect(result["git-diff"].status).toBe("not_applicable");
  });

  test("tsc scheduled only for .ts/.tsx changed files", async () => {
    const tsconfigPath = join(tmp, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");

    const caps = makeCaps({
      hasTsc: true,
      tsconfigPaths: [tsconfigPath],
    });

    // No .ts files changed → tsc should not run
    const resultNoTs = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "file.py")],
      caps,
    });
    expect(resultNoTs.tsc.status).toBe("not_applicable");

    // .ts file changed → tsc should run
    const resultTs = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "src.ts")],
      caps,
    });
    // tsc was scheduled — status will be ok or error (not not_applicable)
    expect(resultTs.tsc.status).not.toBe("not_applicable");
  });

  test("eslint filters only JS/TS extensions", async () => {
    // eslint.config.js needed for ESLint v9
    writeFileSync(join(tmp, "eslint.config.js"), "export default [{rules:{}}];\n");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "test", type: "module" }));
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, "data.py"), "# python file\n");

    const caps = makeCaps({ hasEslint: true });

    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "src.ts"), join(tmp, "data.py")],
      caps,
    });

    // eslint should be scheduled (ts file is in list)
    // Python file filtered out, only src.ts passed
    expect(result.eslint.status).not.toBe("not_applicable");
  });

  test("eslint not scheduled when only non-JS/TS files changed", async () => {
    const caps = makeCaps({ hasEslint: true });

    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "data.py"), join(tmp, "README.md")],
      caps,
    });

    expect(result.eslint.status).toBe("not_applicable");
  });

  test("Promise.all parallel: result contains all four tool keys", async () => {
    // Verify the aggregator returns deterministic Record shape
    const caps = makeCaps();
    const result = await runTools({ cwd: tmp, changedFiles: [], caps });

    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["eslint", "git-diff", "owaspHints", "ripgrep", "securityFindings", "tsc", "webSearchSources"]);
  });

  test("custom timeouts honored: tsc timeout=1 → tsc status timeout", async () => {
    const tsconfigPath = join(tmp, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");

    const caps = makeCaps({
      hasTsc: true,
      tsconfigPaths: [tsconfigPath],
    });

    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "src.ts")],
      caps,
      timeoutsMs: { tsc: 1 },
    });

    expect(result.tsc.status).toBe("timeout");
  });

  test("partial success: tsc timeout does not cascade to git-diff", async () => {
    // One tool timing out must not affect other tools — all run in parallel via Promise.all.
    const tsconfigPath = join(tmp, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    writeFileSync(join(tmp, "src.ts"), "const x = 1;\n");

    // Set up a real git repo so git-diff can succeed.
    await initGitRepo(tmp);

    const caps = makeCaps({
      hasTsc: true,
      tsconfigPaths: [tsconfigPath],
      hasGit: true,
      hasEslint: true,
    });

    const result = await runTools({
      cwd: tmp,
      changedFiles: [join(tmp, "src.ts")],
      caps,
      timeoutsMs: { tsc: 1 },
    });

    // tsc must have timed out
    expect(result.tsc.status).toBe("timeout");

    // git-diff should complete independently — ok or not_applicable, never timeout
    expect(["ok", "not_applicable"]).toContain(result["git-diff"].status);
    expect(result["git-diff"].status).not.toBe("timeout");
  });

  describe("security fields", () => {
    test("result always has securityFindings and owaspHints arrays", async () => {
      const caps = makeCaps();
      const result = await runTools({ cwd: tmp, changedFiles: [], caps });

      expect(Array.isArray(result.securityFindings)).toBe(true);
      expect(Array.isArray(result.owaspHints)).toBe(true);
    });

    test("detects secrets in changed file → securityFindings non-empty", async () => {
      const secretFile = join(tmp, "config.ts");
      writeFileSync(secretFile, "const token = 'ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';\n");

      const caps = makeCaps();
      const result = await runTools({ cwd: tmp, changedFiles: [secretFile], caps });

      expect(result.securityFindings.length).toBeGreaterThan(0);
      expect(result.securityFindings[0].severity).toBe("high");
    });

    test("auth-named file in changedFiles → owaspHints includes A07", async () => {
      const authFile = join(tmp, "auth-login.ts");
      writeFileSync(authFile, "export function login() {}\n");

      const caps = makeCaps();
      const result = await runTools({ cwd: tmp, changedFiles: [authFile], caps });

      expect(result.owaspHints.some((h) => h.owasp_id === "A07")).toBe(true);
    });

    test("no changed files → securityFindings and owaspHints are empty", async () => {
      const caps = makeCaps();
      const result = await runTools({ cwd: tmp, changedFiles: [], caps });

      expect(result.securityFindings).toHaveLength(0);
      expect(result.owaspHints).toHaveLength(0);
    });

    test("taint vulnerability in changed file → securityFindings includes taint trigger", async () => {
      const taintFile = join(tmp, "handler.ts");
      writeFileSync(taintFile, `import { exec } from "child_process";\nexec(req.body.cmd, cb);\n`);

      const caps = makeCaps();
      const result = await runTools({ cwd: tmp, changedFiles: [taintFile], caps });

      expect(result.securityFindings.some((f) => f.rule_id === "taint-cmd")).toBe(true);
    });
  });

  // child span tests
  describe("per-tool child spans", () => {
    /** Minimal in-memory TraceStore stub */
    class FakeStore {
      spans: Span[] = [];
      async writeSpan(span: Span): Promise<void> { this.spans.push(span); }
    }

    test("when tracing provided, emits child spans with siltpoke.kind=tool", async () => {
      const tracer = new Tracer();
      const store = new FakeStore();
      const rootSpan = tracer.startSpan({ name: "root", kind: "INTERNAL" });

      const caps = makeCaps();
      await runTools({
        cwd: tmp,
        changedFiles: [],
        caps,
        tracing: { tracer, traceStore: store as never, parentSpan: rootSpan },
      });

      // ripgrep always runs — should have a child span
      const toolSpans = store.spans.filter((s) => s.name.startsWith("siltpoke.tool."));
      expect(toolSpans.length).toBeGreaterThanOrEqual(1);

      for (const span of toolSpans) {
        expect(span.attributes["siltpoke.kind"]).toBe("tool");
        expect(typeof span.attributes["siltpoke.input"]).toBe("string");
        expect(typeof span.attributes["siltpoke.output"]).toBe("string");
        expect(span.parent_span_id).toBe(rootSpan.span_id);
      }
    });

    test("when tracing absent, no spans emitted (back-compat)", async () => {
      const caps = makeCaps();
      // Should not throw; no store to check — just verify result shape is intact
      const result = await runTools({ cwd: tmp, changedFiles: [], caps });
      expect(result).toHaveProperty("tsc");
      expect(result).toHaveProperty("ripgrep");
    });

    test("child span for git-diff emits when hasGit=true and git repo exists", async () => {
      await initGitRepo(tmp);
      const tracer = new Tracer();
      const store = new FakeStore();
      const rootSpan = tracer.startSpan({ name: "root", kind: "INTERNAL" });

      const caps = makeCaps({ hasGit: true });
      await runTools({
        cwd: tmp,
        changedFiles: [],
        caps,
        tracing: { tracer, traceStore: store as never, parentSpan: rootSpan },
      });

      const gitDiffSpan = store.spans.find((s) => s.name === "siltpoke.tool.git-diff");
      expect(gitDiffSpan).toBeDefined();
      if (gitDiffSpan) {
        expect(gitDiffSpan.attributes["siltpoke.tool.name"]).toBe("git-diff");
        expect(gitDiffSpan.attributes["siltpoke.kind"]).toBe("tool");
        // duration_ms should be a non-negative number
        expect(typeof gitDiffSpan.attributes["siltpoke.tool.duration_ms"]).toBe("number");
        expect((gitDiffSpan.attributes["siltpoke.tool.duration_ms"] as number)).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
