/**
 * Unit tests — index-time anchor discovery (alias-edge resolution).
 *
 * Discovery is fed pure inputs here (file-path lists + import tuples / parsed
 * config objects) — the disk-reading orchestrator is tested separately.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  discoverAnchorMap,
  discoverPythonRoots,
  tsAliasRulesFromConfig,
} from "../../src/repo-graph/anchor-discovery";
import type { RepoGraph } from "../../src/repo-graph/types";

const fileNode = (path: string): RepoGraph["nodes"][number] => ({
  id: `file:${path}:`,
  type: "file",
  name: path.split("/").pop() ?? path,
  path,
  lineRange: [1, 1],
});

// --- Python structural import-anchored inference ----------------------------

describe("discoverPythonRoots — structural import-anchored inference", () => {
  test("infers src/ as the source root via __init__ chain + unique resolution", () => {
    const files = [
      "src/mypkg/__init__.py",
      "src/mypkg/models.py",
      "src/mypkg/sub/__init__.py",
      "src/mypkg/sub/svc.py",
      "src/mypkg/missing_ref.py",
    ];
    const imports = [
      { src: "src/mypkg/sub/svc.py", target: "mypkg.models" }, // resolvable under src/
      { src: "src/mypkg/missing_ref.py", target: "mypkg.nope" }, // unresolvable
    ];
    expect(discoverPythonRoots(files, imports)).toEqual(["src/"]);
  });

  test("a package under TWO roots resolved only by an ambiguous import → not confirmed", () => {
    const files = [
      "a/pkg/__init__.py",
      "a/pkg/m.py",
      "b/pkg/__init__.py",
      "b/pkg/m.py",
    ];
    const imports = [{ src: "x.py", target: "pkg.m" }]; // resolves under a/ AND b/ → ambiguous
    expect(discoverPythonRoots(files, imports)).toEqual([]);
  });

  test("the repo root is never baked as an extra root (tier-3 already covers it)", () => {
    const files = ["agent/__init__.py", "agent/graph.py"];
    const imports = [{ src: "main.py", target: "agent.graph" }]; // resolves at repo root
    expect(discoverPythonRoots(files, imports)).toEqual([]);
  });

  test("a coincidental suffix without an __init__ package is NOT a root", () => {
    // `data/mypkg/models.py` exists but `data/mypkg/__init__.py` does NOT →
    // mypkg is not a real package under data/ → no root.
    const files = ["data/mypkg/models.py"];
    const imports = [{ src: "x.py", target: "mypkg.models" }];
    expect(discoverPythonRoots(files, imports)).toEqual([]);
  });
});

// --- TS path-alias rules from a parsed config -------------------------------

describe("tsAliasRulesFromConfig — generic paths + baseUrl", () => {
  test("emits a rule per paths entry, multi-target preserved, scoped to config dir", () => {
    const rules = tsAliasRulesFromConfig("frontend/", {
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["./src/*"],
          "~/*": ["./src/*"],
          "@dup/*": ["./src/*", "./lib/*"],
        },
      },
    });
    expect(rules).toEqual([
      { scopeDir: "frontend/", prefix: "@/", targets: ["frontend/src/"] },
      { scopeDir: "frontend/", prefix: "~/", targets: ["frontend/src/"] },
      {
        scopeDir: "frontend/",
        prefix: "@dup/",
        targets: ["frontend/src/", "frontend/lib/"],
      },
    ]);
  });

  test("baseUrl-only (no paths) → a single empty-prefix rule", () => {
    const rules = tsAliasRulesFromConfig("", {
      compilerOptions: { baseUrl: "./src" },
    });
    expect(rules).toEqual([{ scopeDir: "", prefix: "", targets: ["src/"] }]);
  });

  test("no paths and no baseUrl → no rules", () => {
    expect(tsAliasRulesFromConfig("", { compilerOptions: {} })).toEqual([]);
    expect(tsAliasRulesFromConfig("", {})).toEqual([]);
  });
});

// --- discoverAnchorMap: the disk-reading orchestrator over a real fixture ----

describe("discoverAnchorMap — reads a fixture's real tsconfig from disk", () => {
  test("ts-multi-alias fixture → all declared alias prefixes, targets scoped", () => {
    const root = join(
      import.meta.dir,
      "..",
      "fixtures",
      "alias-repos",
      "ts-multi-alias",
    );
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        fileNode("tsconfig.json"),
        fileNode("src/index.ts"),
        fileNode("src/util.ts"),
        fileNode("lib/helper.ts"),
      ],
      edges: [],
    };
    const am = discoverAnchorMap(root, graph);
    expect(am.tsAliases.map((r) => r.prefix).sort()).toEqual(["@app/", "@dup/", "~/"]);
    expect(am.tsAliases.find((r) => r.prefix === "~/")?.targets).toEqual(["src/"]);
    expect(am.tsAliases.find((r) => r.prefix === "@app/")?.targets).toEqual(["lib/"]);
    expect(am.pythonRoots).toEqual([]);
  });
});
