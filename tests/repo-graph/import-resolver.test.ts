/**
 * generic consume-time import resolution (tier 1–3, no framework hardcode).
 */
import { describe, expect, it } from "bun:test";
import { resolveImportTarget, buildFileIndex } from "../../src/repo-graph/import-resolver";
import type { RepoGraph } from "../../src/repo-graph/types";

const idx = new Set<string>([
  "src/a/x.ts",
  "src/b/y.ts",
  "src/b/index.ts",
  "src/c/y.tsx",
  "agent/nodes/synthesizer.py",
  "agent/nodes/__init__.py",
  "agent/state.py",
  "agent/__init__.py",
  "db/db_schema.py",
  "config.py",
]);

describe("resolveImportTarget — tier 1 relative (TS)", () => {
  it("resolves ../b/y to the .ts file (extension guess)", () => {
    expect(resolveImportTarget("src/a/x.ts", "../b/y", idx)).toBe("src/b/y.ts");
  });
  it("resolves ./y within the same dir", () => {
    expect(resolveImportTarget("src/c/x.ts", "./y", idx)).toBe("src/c/y.tsx");
  });
  it("resolves a directory import to its index file", () => {
    expect(resolveImportTarget("src/a/x.ts", "../b", idx)).toBe("src/b/index.ts");
  });
  it("returns null for an unresolvable relative path", () => {
    expect(resolveImportTarget("src/a/x.ts", "../nope/gone", idx)).toBeNull();
  });
  it("maps a NodeNext/ESM `.js` specifier to its `.ts` source (generic TS rule)", () => {
    // import '../b/y.js' in a TS file resolves to src/b/y.ts — the dominant ESM
    // convention; the old resolver dropped these (a repo went 12 edges → 0).
    expect(resolveImportTarget("src/a/x.ts", "../b/y.js", idx)).toBe("src/b/y.ts");
    expect(resolveImportTarget("src/a/x.ts", "../c/y.js", idx)).toBe("src/c/y.tsx");
  });
});

describe("resolveImportTarget — tier 3 Python dotted + tier 1 Python relative", () => {
  it("resolves a dotted submodule a.b.c → a/b/c.py", () => {
    expect(resolveImportTarget("agent/graph.py", "agent.nodes.synthesizer", idx)).toBe("agent/nodes/synthesizer.py");
  });
  it("resolves a dotted package a.b → a/b/__init__.py", () => {
    expect(resolveImportTarget("agent/graph.py", "agent.nodes", idx)).toBe("agent/nodes/__init__.py");
  });
  it("resolves `from a.b import c` (stored as a.b.c, c a symbol) via last-segment drop", () => {
    // "agent.state.SomeSymbol" → agent/state/SomeSymbol missing → drop → agent/state.py
    expect(resolveImportTarget("agent/graph.py", "agent.state.SomeSymbol", idx)).toBe("agent/state.py");
  });
  it("resolves a Python 1-dot relative .state → current package", () => {
    expect(resolveImportTarget("agent/graph.py", ".state", idx)).toBe("agent/state.py");
  });
  it("resolves a Python 2-dot relative ..state → parent package", () => {
    expect(resolveImportTarget("agent/nodes/x.py", "..state", idx)).toBe("agent/state.py");
  });
  it("resolves a top-level file's 1-dot relative .config → repo-root config.py (no `./` / `.py` key corruption)", () => {
    expect(resolveImportTarget("terminal_app.py", ".config", idx)).toBe("config.py");
  });
});

describe("resolveImportTarget — bare specifiers stay external", () => {
  it("returns null for a bare npm/builtin specifier", () => {
    expect(resolveImportTarget("src/a/x.ts", "react", idx)).toBeNull();
    expect(resolveImportTarget("agent/x.py", "os", idx)).toBeNull();
    expect(resolveImportTarget("src/a/x.ts", "@scope/pkg", idx)).toBeNull();
  });
});

describe("buildFileIndex", () => {
  it("collects only file-node paths", () => {
    const g: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "file:src/a/x.ts:", type: "file", name: "x.ts", path: "src/a/x.ts", lineRange: [1, 5] },
        { id: "function:src/a/x.ts:f", type: "function", name: "f", path: "src/a/x.ts", lineRange: [1, 2] },
      ],
      edges: [],
    };
    const fi = buildFileIndex(g);
    expect(fi.has("src/a/x.ts")).toBe(true);
    expect(fi.size).toBe(1);
  });
});

describe("generic, zero framework hardcode", () => {
  it("the resolver source names no framework / routing convention", async () => {
    const src = await Bun.file("src/repo-graph/import-resolver.ts").text();
    // strip comments — the doc-comment legitimately *names* what is OUT of scope
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["next", "react", "django", "rails", "vue", "angular", "svelte", "app-router", "getServerSideProps"]) {
      expect(code.toLowerCase()).not.toContain(banned);
    }
  });
});
