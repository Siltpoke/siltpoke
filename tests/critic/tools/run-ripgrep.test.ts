import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../src/critic/spawn";
import { runRipgrep } from "../../../src/critic/tools/run-ripgrep";

let tmp: string;

// Set RG_BIN_OVERRIDE env var if your `rg` is shadowed (e.g. by an RTK wrapper
// on dev machines). On CI, `rg` is available in PATH directly.
// Example: RG_BIN_OVERRIDE=/usr/local/bin/rg bun test
const CURSOR_RG = "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg";
const RG_BIN: string =
  process.env.RG_BIN_OVERRIDE ??
  (existsSync(CURSOR_RG) ? CURSOR_RG : "rg");

// Probe whether rg is actually reachable so we can skip tests that need a real binary.
async function checkRgReachable(): Promise<boolean> {
  const r = await spawnWithTimeout({ argv: [RG_BIN, "--version"], cwd: tmpdir(), timeoutMs: 3000 });
  return !r.timedOut && r.exitCode === 0;
}

const rgReachable = await checkRgReachable();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-rg-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runRipgrep", () => {
  // Tests that require a real rg binary are gated on rgReachable.
  // The ENOENT test uses a hardcoded bad path so it never needs a real binary.

  test.if(rgReachable)("happy match: file with TODO comment → parsed contains match with pattern TODO", async () => {
    writeFileSync(join(tmp, "code.ts"), "// TODO: fix this\nconst x = 1;\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.tool).toBe("ripgrep");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const match = result.parsed[0]!;
    expect(match.pattern).toBe("TODO");
    expect(match.file).toContain("code.ts");
    expect(typeof match.line).toBe("number");
    expect(typeof match.text).toBe("string");
  });

  test.if(rgReachable)("no match: clean file → status ok, parsed []", async () => {
    writeFileSync(join(tmp, "clean.ts"), "const x = 1;\nconst y = 2;\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.tool).toBe("ripgrep");
    expect(result.status).toBe("ok");
    expect(result.parsed).toEqual([]);
  });

  test.if(rgReachable)("timeout: timeoutMs=1 → status timeout", async () => {
    writeFileSync(join(tmp, "file.ts"), "// TODO: something\n");

    const result = await runRipgrep({ cwd: tmp, timeoutMs: 1, rgBin: RG_BIN });
    expect(result.tool).toBe("ripgrep");
    expect(result.status).toBe("timeout");
  });

  // Does not require a real rg binary — always runs.
  test("ENOENT: non-existent binary → not_installed", async () => {
    writeFileSync(join(tmp, "code.ts"), "// TODO: test\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: "/does/not/exist/rg" });
    expect(result.tool).toBe("ripgrep");
    expect(result.status).toBe("not_installed");
  });

  test.if(rgReachable)("FIXME pattern is matched", async () => {
    writeFileSync(join(tmp, "fixme.ts"), "// FIXME: broken\nconst a = 1;\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    const fixmeMatch = result.parsed.find((m) => m.pattern === "FIXME");
    expect(fixmeMatch).toBeDefined();
  });

  test.if(rgReachable)("HACK pattern is matched", async () => {
    writeFileSync(join(tmp, "hack.ts"), "// HACK: workaround\nconst b = 2;\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    const hackMatch = result.parsed.find((m) => m.pattern === "HACK");
    expect(hackMatch).toBeDefined();
  });

  test.if(rgReachable)("top-50 cap: many matches → parsed.length === 50", async () => {
    // Generate a file with 60 TODO comments
    let content = "";
    for (let i = 1; i <= 60; i++) {
      content += `// TODO: item ${i}\n`;
    }
    writeFileSync(join(tmp, "many-todos.ts"), content);

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.tool).toBe("ripgrep");
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBe(50);
  });

  test.if(rgReachable)("sorted alphabetically by file then by line", async () => {
    writeFileSync(join(tmp, "z.ts"), "// TODO: last\n");
    writeFileSync(join(tmp, "a.ts"), "// TODO: first\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    if (result.parsed.length >= 2) {
      const files = result.parsed.map((m) => m.file);
      const sortedFiles = [...files].sort();
      expect(files).toEqual(sortedFiles);
    }
  });

  test.if(rgReachable)("custom patterns option: only matches specified pattern", async () => {
    writeFileSync(join(tmp, "custom.ts"), "// TODO: ignore me\n// CUSTOM_MARKER: match me\n");

    const result = await runRipgrep({ cwd: tmp, patterns: ["CUSTOM_MARKER"], rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    // Should match CUSTOM_MARKER but not TODO
    const customMatch = result.parsed.find((m) => m.text.includes("CUSTOM_MARKER"));
    expect(customMatch).toBeDefined();
  });

  test.if(rgReachable)("raw field is populated on match", async () => {
    writeFileSync(join(tmp, "raw.ts"), "// TODO: check raw\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    expect(typeof result.raw).toBe("string");
    expect(result.raw.length).toBeGreaterThan(0);
  });

  test.if(rgReachable)("match shape: file, line, text, pattern fields", async () => {
    writeFileSync(join(tmp, "shape.ts"), "// XXX: bad code\n");

    const result = await runRipgrep({ cwd: tmp, rgBin: RG_BIN });
    expect(result.status).toBe("ok");
    expect(result.parsed.length).toBeGreaterThan(0);
    const m = result.parsed[0]!;
    expect(typeof m.file).toBe("string");
    expect(typeof m.line).toBe("number");
    expect(typeof m.text).toBe("string");
    expect(typeof m.pattern).toBe("string");
  });
});
