import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../src/critic/spawn";
import { runEslint } from "../../../src/critic/tools/run-eslint";

let tmp: string;

/**
 * Probe whether `bunx eslint` can actually launch and exit cleanly so we can
 * skip happy-path tests on dev machines where the local Node/Bun runtime breaks
 * eslint's lazy rule loader. CI Ubuntu has a clean environment and runs them.
 * Tests that don't need eslint to succeed (not_applicable / timeout / ENOENT /
 * no-config exit-2) stay always-on.
 */
async function checkEslintReachable(): Promise<boolean> {
  const r = await spawnWithTimeout({
    argv: ["bunx", "eslint", "--version"],
    cwd: tmpdir(),
    timeoutMs: 8000,
  });
  return !r.timedOut && r.exitCode === 0;
}

const eslintReachable = await checkEslintReachable();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-eslint-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write an ESLint v9 flat config (eslint.config.js) to the given directory.
 * ESLint v9+ requires the new flat config format; .eslintrc.* is no longer supported.
 */
function writeEslintFlatConfig(dir: string, rules: Record<string, unknown> = {}) {
  const rulesJson = JSON.stringify(rules);
  const content = `export default [{ rules: ${rulesJson} }];\n`;
  writeFileSync(join(dir, "eslint.config.js"), content);
  // ESLint v9 flat config needs package.json with "type":"module" for .js config
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", type: "module" }));
}

describe("runEslint", () => {
  test("changedFiles empty → status not_applicable, spawn never called", async () => {
    const result = await runEslint({ cwd: tmp, changedFiles: [] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("not_applicable");
    expect(result.parsed).toEqual([]);
    expect(result.raw).toBe("");
  });

  test.if(eslintReachable)("happy clean: clean JS file → status ok, parsed []", async () => {
    writeEslintFlatConfig(tmp, { "no-unused-vars": "error" });
    const filePath = join(tmp, "clean.js");
    writeFileSync(filePath, "const x = 1;\nconsole.log(x);\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("ok");
    expect(result.parsed).toEqual([]);
  });

  test.if(eslintReachable)("has warnings: unused var with no-unused-vars warn → parsed contains finding", async () => {
    writeEslintFlatConfig(tmp, { "no-unused-vars": "warn" });
    const filePath = join(tmp, "unused.js");
    writeFileSync(filePath, "let unused = 1;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const finding = result.parsed[0]!;
    expect(finding.severity).toBe("warning");
    expect(finding.ruleId).toBe("no-unused-vars");
    expect(finding.file).toContain("unused.js");
  });

  test.if(eslintReachable)("has errors: unused var with no-unused-vars error → parsed contains error finding", async () => {
    writeEslintFlatConfig(tmp, { "no-unused-vars": "error" });
    const filePath = join(tmp, "unused.js");
    writeFileSync(filePath, "var unusedVar = 1;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const finding = result.parsed[0]!;
    expect(finding.severity).toBe("error");
  });

  test("timeout: timeoutMs=1 → status timeout", async () => {
    writeEslintFlatConfig(tmp, {});
    const filePath = join(tmp, "x.js");
    writeFileSync(filePath, "const x = 1;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath], timeoutMs: 1 });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("timeout");
  });

  test.if(eslintReachable)("top-20 cap: many findings → parsed.length === 20", async () => {
    writeEslintFlatConfig(tmp, { "no-unused-vars": "error" });
    const filePath = join(tmp, "many.js");
    let content = "";
    for (let i = 1; i <= 30; i++) {
      content += `var unused${i} = ${i};\n`;
    }
    writeFileSync(filePath, content);

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBe(20);
  });

  test.if(eslintReachable)("parsed finding shape: file, line, col, severity, ruleId, message", async () => {
    writeEslintFlatConfig(tmp, { "no-unused-vars": "error" });
    const filePath = join(tmp, "shape.js");
    writeFileSync(filePath, "var x = 1;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.parsed.length).toBeGreaterThan(0);
    const f = result.parsed[0]!;
    expect(typeof f.file).toBe("string");
    expect(typeof f.line).toBe("number");
    expect(typeof f.col).toBe("number");
    expect(["error", "warning"]).toContain(f.severity);
    expect(typeof f.ruleId).toBe("string");
    expect(typeof f.message).toBe("string");
  });

  test.if(eslintReachable)("errors sorted before warnings when mixed", async () => {
    // Two rules: one warns, one errors
    writeEslintFlatConfig(tmp, {
      "no-unused-vars": "warn",
      "no-var": "error",
    });
    const filePath = join(tmp, "mixed.js");
    // var triggers "no-var" (error) and "no-unused-vars" (warn) at once
    writeFileSync(filePath, "var x = 1;\nvar y = 2;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.status).toBe("ok");
    if (result.parsed.length >= 2) {
      expect(result.parsed[0]?.severity).toBe("error");
    }
  });

  test("ENOENT: empty PATH → status not_installed (runner-level round-trip)", async () => {
    // Pass an empty-PATH env override via the _env test affordance so that
    // the spawned bunx is not found. runEslint must return status "not_installed".
    const emptyBin = mkdtempSync(join(tmpdir(), "siltpoke-emptypath-"));
    const filePath = join(tmp, "x.js");
    writeFileSync(filePath, "const a = 1;\n");

    try {
      const result = await runEslint({
        cwd: tmp,
        changedFiles: [filePath],
        timeoutMs: 5000,
        _env: { PATH: emptyBin },
      });
      expect(result.tool).toBe("eslint");
      expect(result.status).toBe("not_installed");
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("no-config: no eslint.config.js → status error (ESLint v9 exits 2)", async () => {
    // No eslint.config.js and no .eslintrc* — ESLint v9 should exit with code 2.
    const filePath = join(tmp, "plain.js");
    writeFileSync(filePath, "var x = 1;\n");

    const result = await runEslint({ cwd: tmp, changedFiles: [filePath] });
    expect(result.tool).toBe("eslint");
    expect(result.status).toBe("error");
  });
});
