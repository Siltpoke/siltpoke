import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWhere } from "../../src/cli/where";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "siltpoke-where-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("runWhere", () => {
  test("prints JSON with source=fallback for non-project cwd", () => {
    let captured = "";
    const code = runWhere({ cwd: scratch, out: (s) => (captured += s) });
    expect(code).toBe(0);
    const parsed = JSON.parse(captured);
    expect(parsed.source).toBe("fallback");
    expect(parsed.project_root).toBe(scratch);
    expect(parsed.project_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("prints JSON with source=git when .git exists", () => {
    mkdirSync(join(scratch, ".git"));
    let captured = "";
    runWhere({ cwd: scratch, out: (s) => (captured += s) });
    const parsed = JSON.parse(captured);
    expect(parsed.source).toBe("git");
    expect(parsed.project_root).toBe(scratch);
  });

  test("prints JSON with source=marker when marker.json present", () => {
    mkdirSync(join(scratch, ".siltpoke"));
    writeFileSync(
      join(scratch, ".siltpoke", "marker.json"),
      JSON.stringify({
        project_id: "abcd1234abcd1234",
        project_root: scratch,
        display_name: "renamed-thing",
        written_by: "siltpoke",
        written_at: "2026-05-16T10:00:00Z",
      }),
    );
    let captured = "";
    runWhere({ cwd: scratch, out: (s) => (captured += s) });
    const parsed = JSON.parse(captured);
    expect(parsed.source).toBe("marker");
    expect(parsed.project_id).toBe("abcd1234abcd1234");
    expect(parsed.display_name).toBe("renamed-thing");
  });
});
