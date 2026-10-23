/**
 * projectArchitecture() projection-layer tests.
 *
 * Asserts the data-contract `ArchitectureProjection` shape: derived group
 * ids/short/accent, subdir id (last path segment), inbound/outbound weight
 * sums, edge id mapping, and the `repo` block from meta.
 */
import { test, expect, describe } from "bun:test";
import {
  bucketIdOfPath,
  projectArchitecture,
  ROOT_BUCKET_ID,
  subdirsWithPath,
  type ArchitectureProjection,
} from "../../src/repo-graph/project-architecture";
import type { ArchitectureOverlay } from "../../src/repo-graph/architecture-parser";
import type {
  RepoGraph,
  RepoGraphMeta,
  SiltpokeGraphEdge,
  SiltpokeGraphNode,
} from "../../src/repo-graph/types";
import { emptyCounters, emptyGraph } from "../../src/repo-graph/types";
import { tokens } from "../../src/web/tokens/tokens";

function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path, path, lineRange: [1, 100] };
}

function importsEdge(sourcePath: string, importStr: string): SiltpokeGraphEdge {
  return {
    id: `file:${sourcePath}:::imports::${importStr}`,
    source: `file:${sourcePath}:`,
    target: importStr,
    type: "imports",
    weight: 1,
  };
}

function makeGraph(filePaths: string[], imports: Array<[string, string]> = []): RepoGraph {
  const g = emptyGraph();
  g.nodes = filePaths.map(fileNode);
  g.edges = imports.map(([src, imp]) => importsEdge(src, imp));
  return g;
}

function makeMeta(over: Partial<RepoGraphMeta> = {}): RepoGraphMeta {
  const counters = emptyCounters();
  counters.nodes.file = 9;
  counters.nodes.function = 40;
  counters.nodes.class = 2;
  counters.nodes.symbol = 5;
  counters.edges.imports = 7043;
  return {
    schemaVersion: 1,
    project_root: "/Users/x/dev/siltpoke",
    proj_hash: "a1b2c3d4e5f6",
    last_indexed_ts: "2026-05-29T14:31:00Z",
    build_duration_ms: 1234,
    counters,
    ...over,
  };
}

const OVERLAY: ArchitectureOverlay = {
  superGroups: [
    {
      name: "Core LLM + orchestration",
      subdirs: [
        { path: "src/brain/", purpose: "claude -p subprocess" },
        { path: "src/critic/", purpose: "rubric rules" },
      ],
    },
    {
      name: "State / persistence",
      subdirs: [{ path: "src/explain/", purpose: "explain orchestrator" }],
    },
  ],
};

describe("projectArchitecture — groups", () => {
  const graph = makeGraph(
    ["src/brain/a.ts", "src/critic/b.ts", "src/explain/c.ts"],
    [
      ["src/explain/c.ts", "../brain/a"],
      ["src/explain/c.ts", "../critic/b"],
      ["src/critic/b.ts", "../brain/a"],
    ],
  );
  const proj: ArchitectureProjection = projectArchitecture(graph, OVERLAY, makeMeta());

  test("derives group id + short from panel name first token", () => {
    // Accent asserted against tokens.color.* rather than a hardcoded hex
    // (final dark-mode branch review, Important 3): GROUP_ACCENTS' first 4
    // entries are now `tokens.color.terra`/`moss`/`sky`/`amber`, so pinning
    // a literal "#d96b6b" here would make this test the ONE place in the
    // codebase still assuming the pre-migration light-only value.
    expect(proj.groups[0]).toEqual({
      id: "core",
      title: "Core LLM + orchestration",
      short: "Core",
      accent: tokens.color.terra,
    });
    expect(proj.groups[1]!.id).toBe("state");
    expect(proj.groups[1]!.short).toBe("State");
    expect(proj.groups[1]!.accent).toBe(tokens.color.moss);
  });
});

describe("projectArchitecture — subdirs", () => {
  const graph = makeGraph(
    ["src/brain/a.ts", "src/critic/b.ts", "src/explain/c.ts"],
    [
      ["src/explain/c.ts", "../brain/a"],
      ["src/explain/c.ts", "../critic/b"],
      ["src/critic/b.ts", "../brain/a"],
    ],
  );
  const proj = projectArchitecture(graph, OVERLAY, makeMeta());

  test("subdir id is the last path segment; group is the derived group id", () => {
    const explain = proj.subdirs.find((s) => s.id === "explain");
    expect(explain).toBeDefined();
    expect(explain!.group).toBe("state");
    expect(explain!.purpose).toBe("explain orchestrator");
    expect(explain!.files).toBe(1);
  });

  test("inbound/outbound weight sums per subdir", () => {
    // explain → brain, explain → critic  ⇒ explain.outbound = 2
    const explain = proj.subdirs.find((s) => s.id === "explain")!;
    expect(explain.outbound).toBe(2);
    expect(explain.inbound).toBe(0);
    // brain imported by explain + critic ⇒ brain.inbound = 2
    const brain = proj.subdirs.find((s) => s.id === "brain")!;
    expect(brain.inbound).toBe(2);
    expect(brain.outbound).toBe(0);
  });
});

describe("projectArchitecture — edges + repo block", () => {
  const graph = makeGraph(
    ["src/brain/a.ts", "src/explain/c.ts"],
    [["src/explain/c.ts", "../brain/a"]],
  );
  const proj = projectArchitecture(graph, OVERLAY, makeMeta());

  test("edges map subdir-path endpoints to ids with weight", () => {
    expect(proj.edges).toContainEqual({ source: "explain", target: "brain", weight: 1 });
  });

  test("repo block: id/name/path/files/symbols/edges from meta", () => {
    expect(proj.repo.id).toBe("a1b2c3d4e5f6");
    expect(proj.repo.name).toBe("siltpoke");
    expect(proj.repo.path).toMatch(/siltpoke$/);
    expect(proj.repo.files).toBe(9);
    expect(proj.repo.symbols).toBe(47); // 40 fn + 2 class + 5 symbol
    expect(proj.repo.edges).toBe(7043);
    expect(proj.repo.building).toBe(false);
  });

  test("building flag reflects meta.building", () => {
    const p2 = projectArchitecture(graph, OVERLAY, makeMeta({ building: true }));
    expect(p2.repo.building).toBe(true);
  });
});

describe("projectArchitecture — container stats (funcCount + recurring basenames)", () => {
  // Real indexed file nodes carry the basename in `name`; container-stats keys
  // recurring on node.name, so the test graph must mirror that (not name=path).
  function realFile(path: string): SiltpokeGraphNode {
    return {
      id: `file:${path}:`,
      type: "file",
      name: path.split("/").pop()!,
      path,
      lineRange: [1, 100],
    };
  }
  function fnNode(path: string, name: string): SiltpokeGraphNode {
    return {
      id: `function:${path}:${name}`,
      type: "function",
      name,
      path,
      lineRange: [1, 1],
    };
  }

  const overlay: ArchitectureOverlay = {
    superGroups: [
      {
        name: "Core LLM + orchestration",
        subdirs: [{ path: "src/critic/", purpose: "rubric rules" }],
      },
    ],
  };
  const g = emptyGraph();
  g.nodes = [
    realFile("src/critic/a/page.tsx"),
    realFile("src/critic/b/page.tsx"),
    realFile("src/critic/uniq.ts"),
    fnNode("src/critic/uniq.ts", "run"),
  ];
  const proj = projectArchitecture(g, overlay, makeMeta());

  test("subdir carries recurring basenames (data) + funcCount", () => {
    const critic = proj.subdirs.find((s) => s.id === "critic")!;
    expect(critic.recurringBasenames).toEqual([{ name: "page.tsx", count: 2 }]);
    expect(critic.funcCount).toBe(1);
    expect(critic.files).toBe(3);
  });
});

describe("projectArchitecture — degraded mode (no overlay)", () => {
  test("one group per src child; group id derived from subdir name", () => {
    const graph = makeGraph(["src/foo/a.ts", "src/bar/b.ts"]);
    const proj = projectArchitecture(graph, null, makeMeta());
    const ids = proj.subdirs.map((s) => s.id).sort();
    expect(ids).toEqual(["bar", "foo"]);
    // degraded: each subdir is its own panel → group id = subdir id
    expect(proj.subdirs.find((s) => s.id === "foo")!.group).toBe("foo");
  });
});

describe("projectArchitecture — files at the repo root (degraded mode)", () => {
  // agent-runtime shape: main.py at the root beside utils/. main.py used to
  // land in no bucket, so both Code Map views drew 4 of the 5 indexed files.
  const graph = makeGraph(
    ["main.ts", "utils/a.ts", "utils/b.ts"],
    [["main.ts", "./utils/a"]],
  );
  const proj = projectArchitecture(graph, null, makeMeta());

  test("the root files get a bucket with a non-empty id and a file count", () => {
    const root = proj.subdirs.find((s) => s.path === "");
    expect(root).toBeDefined();
    expect(root!.id).toBe(ROOT_BUCKET_ID);
    expect(root!.files).toBe(1);
    expect(root!.group).toBe(ROOT_BUCKET_ID);
    expect(proj.groups.map((g) => g.id)).toContain(ROOT_BUCKET_ID);
  });

  test("bucketIdOfPath resolves a root file to the root bucket, and deeper files still go deeper", () => {
    expect(bucketIdOfPath(proj.subdirs, "main.ts")).toBe(ROOT_BUCKET_ID);
    expect(bucketIdOfPath(proj.subdirs, "utils/a.ts")).toBe("utils");
  });

  test("every indexed file resolves to some bucket", () => {
    for (const n of graph.nodes) expect(bucketIdOfPath(proj.subdirs, n.path)).not.toBeNull();
  });

  test("an import from a root file draws an edge out of the root bucket", () => {
    expect(proj.edges).toEqual([{ source: ROOT_BUCKET_ID, target: "utils", weight: 1 }]);
  });
});

describe("subdirsWithPath", () => {
  // Review of 19d66ecb: the island filtered with `path.length > 0`, so the
  // root bucket never reached bucketIdOfPath and a jump to main.py did nothing.
  test("keeps the root bucket (empty path) and drops only path-less entries", () => {
    const kept = subdirsWithPath([
      { id: ROOT_BUCKET_ID, path: "" },
      { id: "utils", path: "utils/" },
      { id: "legacy" },
    ]);
    expect(kept.map((s) => s.id)).toEqual([ROOT_BUCKET_ID, "utils"]);
    expect(bucketIdOfPath(kept, "main.py")).toBe(ROOT_BUCKET_ID);
  });
});

describe("projectArchitecture — other (non-code) files, Auto view", () => {
  // agent-runtime shape: README.md + requirements.txt at the root, docs/ and
  // tests/ with no indexed code, a note inside utils/.
  const graph = makeGraph(["main.ts", "utils/a.ts", "utils/b.ts"]);
  const others = ["README.md", "requirements.txt", "docs/plan.md", "docs/notes.md", "tests/test_a.py", "utils/NOTES.md"];
  const proj = projectArchitecture(graph, null, makeMeta(), others);
  const byId = new Map(proj.subdirs.map((s) => [s.id, s]));

  test("code buckets keep their code counts and gain an other-file count", () => {
    expect(byId.get(ROOT_BUCKET_ID)).toMatchObject({ files: 1, otherFiles: 2 });
    expect(byId.get("utils")).toMatchObject({ files: 2, otherFiles: 1 });
  });

  test("folders with no code get their own boxes instead of falling into (root)", () => {
    expect(byId.get("docs")).toMatchObject({ path: "docs/", files: 0, otherFiles: 2 });
    expect(byId.get("tests")).toMatchObject({ path: "tests/", files: 0, otherFiles: 1 });
    expect(proj.groups.map((g) => g.id)).toEqual(expect.arrayContaining(["docs", "tests"]));
  });

  test("every other file resolves through bucketIdOfPath to the box that counts it", () => {
    const counted = new Map<string, number>();
    for (const p of others) {
      const id = bucketIdOfPath(proj.subdirs, p);
      expect(id).not.toBeNull();
      counted.set(id!, (counted.get(id!) ?? 0) + 1);
    }
    for (const s of proj.subdirs) expect(counted.get(s.id) ?? 0).toBe(s.otherFiles ?? 0);
  });

  test("code buckets are exactly what they are without other files", () => {
    const plain = projectArchitecture(graph, null, makeMeta());
    const codeOnly = proj.subdirs.filter((s) => s.files > 0).map(({ otherFiles: _o, ...s }) => s);
    expect(codeOnly).toEqual(plain.subdirs);
    expect(proj.edges).toEqual(plain.edges);
  });

  test("an authored CLAUDE.md overlay view ignores other files", () => {
    const withOverlay = projectArchitecture(graph, OVERLAY, makeMeta(), others);
    expect(withOverlay).toEqual(projectArchitecture(graph, OVERLAY, makeMeta()));
  });

  test("no other-files list (an older index) changes nothing", () => {
    expect(projectArchitecture(graph, null, makeMeta(), null)).toEqual(projectArchitecture(graph, null, makeMeta()));
  });
});

describe("projectArchitecture — other-file boxes never share an id", () => {
  // Review of the other-files branch: tests/ mirroring src/ gave a second
  // "daemon" box, and every id-keyed reader merged the two.
  const graph = makeGraph(["src/daemon/a.ts", "src/web/b.ts", "src/cli/c.ts"]);
  const others = ["tests/daemon/a.test.ts", "tests/web/b.test.ts", "docs/daemon/notes.md", "README.md"];
  const proj = projectArchitecture(graph, null, makeMeta(), others);

  test("ids are unique", () => {
    const ids = proj.subdirs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a colliding box takes its path as id; the code box keeps its name", () => {
    const byPath = new Map(proj.subdirs.map((s) => [s.path, s.id]));
    expect(byPath.get("src/daemon/")).toBe("daemon");
    expect(byPath.get("tests/daemon/")).toBe("tests/daemon");
    expect(byPath.get("docs/daemon/")).toBe("docs/daemon");
  });

  test("every file — code and other — resolves to the box (by path) that counts it", () => {
    const counted = new Map<string, number>();
    for (const p of [...others, ...graph.nodes.map((n) => n.path)]) {
      const id = bucketIdOfPath(proj.subdirs, p);
      const box = proj.subdirs.find((s) => s.id === id);
      expect(box).toBeDefined();
      counted.set(box!.path, (counted.get(box!.path) ?? 0) + 1);
    }
    for (const s of proj.subdirs) expect(counted.get(s.path) ?? 0).toBe(s.files + (s.otherFiles ?? 0));
  });
});
