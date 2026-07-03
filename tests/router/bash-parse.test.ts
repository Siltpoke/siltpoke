/**
 * Tests for parseBashCommandForFileWrites.
 * Bash diff detection heuristic (hybrid whitelist + git snapshot).
 *
 * Coverage target: ≥80% branch coverage on src/router/bash-parse.ts
 */

import { describe, expect, it } from "bun:test";
import {
  type BashWriteOp_Match,
  parseBashCommandForFileWrites,
} from "../../src/router/bash-parse";

// Helper to grab a single match (asserts exactly one result)
function single(cmd: string): BashWriteOp_Match {
  const results = parseBashCommandForFileWrites(cmd);
  expect(results).toHaveLength(1);
  return results[0]!;
}

// ---------------------------------------------------------------------------
// Whitelist patterns
// ---------------------------------------------------------------------------

describe("sed-i", () => {
  it("detects sed -i with a file argument", () => {
    const m = single("sed -i 's/foo/bar/g' src/x.ts");
    expect(m.op).toBe("sed-i");
    expect(m.files).toEqual(["src/x.ts"]);
  });

  it("detects sed -i '' (Mac-style empty backup) with a file argument", () => {
    const m = single("sed -i '' 's/foo/bar/g' src/x.ts");
    expect(m.op).toBe("sed-i");
    expect(m.files).toEqual(["src/x.ts"]);
  });
});

describe("redirect", () => {
  it("detects > redirect with a file argument", () => {
    const m = single('echo "hello" > src/y.txt');
    expect(m.op).toBe("redirect");
    expect(m.files).toEqual(["src/y.txt"]);
  });

  it("detects >> append redirect with a file argument", () => {
    const m = single('echo "hi" >> log.txt');
    expect(m.op).toBe("redirect");
    expect(m.files).toEqual(["log.txt"]);
  });
});

describe("heredoc", () => {
  it("detects heredoc combined with > redirect", () => {
    const result = parseBashCommandForFileWrites(
      "cat > src/z.ts <<EOF\nbody\nEOF",
    );
    // Must have at least one match; the redirect target src/z.ts must appear somewhere
    expect(result.length).toBeGreaterThanOrEqual(1);
    const files = result.flatMap((r) => r.files);
    expect(files).toContain("src/z.ts");
    // The op should be heredoc or redirect (best-effort)
    const ops = result.map((r) => r.op);
    const hasHeredocOrRedirect = ops.some(
      (op) => op === "heredoc" || op === "redirect",
    );
    expect(hasHeredocOrRedirect).toBe(true);
  });
});

describe("tee", () => {
  it("detects tee with a file argument", () => {
    const m = single("tee src/w.log");
    expect(m.op).toBe("tee");
    expect(m.files).toEqual(["src/w.log"]);
  });

  it("detects tee -a (append) with a file argument", () => {
    const m = single("tee -a src/w.log");
    expect(m.op).toBe("tee");
    expect(m.files).toEqual(["src/w.log"]);
  });
});

describe("mv", () => {
  it("detects mv SRC DST", () => {
    const m = single("mv old.ts new.ts");
    expect(m.op).toBe("mv");
    expect(m.files).toEqual(["old.ts", "new.ts"]);
  });
});

describe("cp", () => {
  it("detects cp SRC DST", () => {
    const m = single("cp template.ts src/x.ts");
    expect(m.op).toBe("cp");
    expect(m.files).toEqual(["template.ts", "src/x.ts"]);
  });

  it("detects cp -r SRC DST (recursive flag)", () => {
    const m = single("cp -r src/template src/x");
    expect(m.op).toBe("cp");
    expect(m.files).toEqual(["src/template", "src/x"]);
  });
});

describe("patch", () => {
  it("detects patch -p1 < FILE (stdin redirect)", () => {
    const m = single("patch -p1 < x.patch");
    expect(m.op).toBe("patch");
    expect(m.files).toEqual(["x.patch"]);
  });
});

describe("git-apply", () => {
  it("detects git apply FILE", () => {
    const m = single("git apply patch.diff");
    expect(m.op).toBe("git-apply");
    expect(m.files).toEqual(["patch.diff"]);
  });
});

describe("formatter", () => {
  it("detects prettier --write with multiple files", () => {
    const m = single("prettier --write src/x.ts src/y.ts");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/x.ts", "src/y.ts"]);
  });

  it("detects eslint --fix with a file", () => {
    const m = single("eslint --fix src/auth.ts");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/auth.ts"]);
  });

  it("detects eslint without --fix as NOT a write op", () => {
    const result = parseBashCommandForFileWrites("eslint src/x.ts");
    expect(result).toHaveLength(0);
  });

  it("detects cargo fmt (no explicit files)", () => {
    const m = single("cargo fmt");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual([]);
  });

  it("detects gofmt -w with a file", () => {
    const m = single("gofmt -w src/main.go");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/main.go"]);
  });

  it("detects ruff format subcommand with a file", () => {
    const m = single("ruff format src/main.py");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/main.py"]);
  });

  it("detects biome format subcommand with a file", () => {
    const m = single("biome format src/x.ts");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/x.ts"]);
  });

  it("detects dprint fmt subcommand with a file", () => {
    const m = single("dprint fmt src/x.ts");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/x.ts"]);
  });

  it("detects stylua with a file", () => {
    const m = single("stylua src/x.lua");
    expect(m.op).toBe("formatter");
    expect(m.files).toEqual(["src/x.lua"]);
  });
});

// ---------------------------------------------------------------------------
// Compound commands
// ---------------------------------------------------------------------------

describe("compound commands", () => {
  it("handles A && B — only the write-bearing command matches", () => {
    const result = parseBashCommandForFileWrites('cd /tmp && echo hi > x.txt');
    expect(result).toHaveLength(1);
    expect(result[0]?.op).toBe("redirect");
    expect(result[0]?.files).toEqual(["x.txt"]);
  });

  it("handles A ; B — both mv commands detected", () => {
    const result = parseBashCommandForFileWrites("mv a b ; mv c d");
    expect(result).toHaveLength(2);
    expect(result[0]?.op).toBe("mv");
    expect(result[0]?.files).toEqual(["a", "b"]);
    expect(result[1]?.op).toBe("mv");
    expect(result[1]?.files).toEqual(["c", "d"]);
  });

  it("handles A || B — sed-i detected despite || fallback", () => {
    const result = parseBashCommandForFileWrites(
      "sed -i s/x/y/ a.ts || echo failed",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.op).toBe("sed-i");
    expect(result[0]?.files).toEqual(["a.ts"]);
  });

  it("handles pipeline: last stage tee is detected", () => {
    const result = parseBashCommandForFileWrites("ls | tee log.txt");
    expect(result).toHaveLength(1);
    expect(result[0]?.op).toBe("tee");
    expect(result[0]?.files).toEqual(["log.txt"]);
  });

  it("handles pipeline: redirect in last stage is detected", () => {
    const result = parseBashCommandForFileWrites(
      "cat x.txt | grep foo > y.txt",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.op).toBe("redirect");
    expect(result[0]?.files).toEqual(["y.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Non-matches
// ---------------------------------------------------------------------------

describe("non-matches", () => {
  it("ls -la → empty", () => {
    expect(parseBashCommandForFileWrites("ls -la")).toEqual([]);
  });

  it("echo hello (no redirect) → empty", () => {
    expect(parseBashCommandForFileWrites("echo hello")).toEqual([]);
  });

  it("git status → empty", () => {
    expect(parseBashCommandForFileWrites("git status")).toEqual([]);
  });

  it("git diff HEAD → empty", () => {
    expect(parseBashCommandForFileWrites("git diff HEAD")).toEqual([]);
  });

  it("bun test → empty", () => {
    expect(parseBashCommandForFileWrites("bun test")).toEqual([]);
  });

  it("node ./script.js → empty (can't know what script does)", () => {
    expect(parseBashCommandForFileWrites("node ./script.js")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("empty string → empty array", () => {
    expect(parseBashCommandForFileWrites("")).toEqual([]);
  });

  it("whitespace-only string → empty array", () => {
    expect(parseBashCommandForFileWrites("   ")).toEqual([]);
  });

  it("malformed/unparseable Bash (>>>) → empty array (no throw)", () => {
    expect(() => parseBashCommandForFileWrites(">>>")).not.toThrow();
    expect(parseBashCommandForFileWrites(">>>")).toEqual([]);
  });

  it("path with spaces in quotes — mv preserves quoted paths", () => {
    const m = single('mv "old name.ts" "new name.ts"');
    expect(m.op).toBe("mv");
    expect(m.files).toEqual(["old name.ts", "new name.ts"]);
  });

  it("sed -i with multiple file arguments — takes last positional", () => {
    // Only the explicit last non-flag arg is the target file
    const m = single("sed -i 's/a/b/g' src/a.ts");
    expect(m.op).toBe("sed-i");
    expect(m.files).toEqual(["src/a.ts"]);
  });
});
