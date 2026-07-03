import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTsc } from "../../../src/critic/tools/run-tsc";
// Note: _env is a test-only affordance on runTsc to override the spawned process env,
// allowing ENOENT simulation without mutating process.env.

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-tsc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTsconfig(dir: string, options: Record<string, unknown> = {}) {
  const config = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      ...options,
    },
  };
  const tsconfigPath = join(dir, "tsconfig.json");
  writeFileSync(tsconfigPath, JSON.stringify(config));
  return tsconfigPath;
}

describe("runTsc", () => {
  test("happy: clean .ts file → status ok, parsed []", async () => {
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "hello.ts"), "const x: number = 42;\n");

    const result = await runTsc({ cwd: tmp, tsconfigPath });
    expect(result.tool).toBe("tsc");
    expect(result.status).toBe("ok");
    expect(result.parsed).toEqual([]);
  });

  test("has errors: type error → parsed contains TS2322 diagnostic", async () => {
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "bad.ts"), "const x: number = \"string\";\n");

    const result = await runTsc({ cwd: tmp, tsconfigPath });
    expect(result.tool).toBe("tsc");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const diag = result.parsed[0]!;
    expect(diag.code).toBe("TS2322");
    expect(diag.severity).toBe("error");
    expect(diag.file).toContain("bad.ts");
    expect(typeof diag.line).toBe("number");
    expect(typeof diag.col).toBe("number");
  });

  test("timeout: timeoutMs=1 → status timeout", async () => {
    // Use a tmp tsconfig so the test is portable (no hardcoded repo paths).
    // tsc still takes >1 ms to start, so timeoutMs:1 reliably fires.
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "x.ts"), "const a: number = 1;\n");
    const result = await runTsc({
      cwd: tmp,
      tsconfigPath,
      timeoutMs: 1,
    });
    expect(result.tool).toBe("tsc");
    expect(result.status).toBe("timeout");
  });

  test("non-existent tsconfigPath → status error", async () => {
    const result = await runTsc({
      cwd: tmp,
      tsconfigPath: join(tmp, "nonexistent-tsconfig.json"),
    });
    expect(result.tool).toBe("tsc");
    expect(result.status).toBe("error");
  });

  test("ENOENT: empty PATH → status not_installed (runner-level round-trip)", async () => {
    // Pass an empty-PATH env override via the _env test affordance so that
    // the spawned bunx is not found. runTsc must return status "not_installed".
    const emptyBin = mkdtempSync(join(tmpdir(), "siltpoke-emptypath-"));
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "x.ts"), "const a = 1;\n");

    try {
      const result = await runTsc({
        cwd: tmp,
        tsconfigPath,
        timeoutMs: 5000,
        _env: { PATH: emptyBin },
      });
      expect(result.tool).toBe("tsc");
      expect(result.status).toBe("not_installed");
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("top-20 cap: >20 errors → parsed.length === 20, errors first", async () => {
    const tsconfigPath = writeTsconfig(tmp);

    // Generate 30 type errors in separate files
    let content = "";
    for (let i = 1; i <= 30; i++) {
      content += `const err${i}: number = "type_error_${i}";\n`;
    }
    writeFileSync(join(tmp, "many-errors.ts"), content);

    const result = await runTsc({ cwd: tmp, tsconfigPath });
    expect(result.tool).toBe("tsc");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBe(20);
    // All returned items should be errors
    for (const diag of result.parsed) {
      expect(diag.severity).toBe("error");
    }
  });

  test("parsed diagnostics contain file, line, col, code, severity, message", async () => {
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "typed.ts"), "const x: number = \"hello\";\n");

    const result = await runTsc({ cwd: tmp, tsconfigPath });
    expect(result.parsed.length).toBeGreaterThan(0);
    const d = result.parsed[0]!;
    expect(typeof d.file).toBe("string");
    expect(typeof d.line).toBe("number");
    expect(typeof d.col).toBe("number");
    expect(typeof d.code).toBe("string");
    expect(["error", "warning"]).toContain(d.severity);
    expect(typeof d.message).toBe("string");
  });

  test("raw field contains stdout output", async () => {
    const tsconfigPath = writeTsconfig(tmp);
    writeFileSync(join(tmp, "err.ts"), "const x: number = \"bad\";\n");

    const result = await runTsc({ cwd: tmp, tsconfigPath });
    expect(typeof result.raw).toBe("string");
    expect(result.raw.length).toBeGreaterThan(0);
  });

  test("monorepo: nested tsconfig is honored (--project wired correctly)", async () => {
    // Root tsconfig — strict mode, would error on the nested file if used instead.
    writeTsconfig(tmp, { strict: true, noEmit: true });

    // Nested package with its own tsconfig — less strict, no errors expected.
    const pkgDir = join(tmp, "packages", "ui");
    mkdirSync(pkgDir, { recursive: true });
    const nestedTsconfig = writeTsconfig(pkgDir, { strict: false, noEmit: true });
    // A file that only compiles cleanly under non-strict config.
    writeFileSync(join(pkgDir, "comp.ts"), "function greet(name) { return 'hi ' + name; }\n");

    const result = await runTsc({ cwd: pkgDir, tsconfigPath: nestedTsconfig });
    expect(result.tool).toBe("tsc");
    // Should compile cleanly using the nested (non-strict) tsconfig.
    expect(result.status).toBe("ok");
    expect(result.parsed).toEqual([]);
  });
});
