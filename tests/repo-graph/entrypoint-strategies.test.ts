import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEntrypoints } from "../../src/repo-graph/detect-entrypoints";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex, SiltpokeNodeType } from "../../src/repo-graph/types";

const dirs: string[] = [];
function tmpPkg(pkg: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "eps-")); dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function add(g: RepoGraph, qi: QueryIndex, type: SiltpokeNodeType, path: string, name: string, line: number, exported = false) {
  const id = `${type}:${path}:${name}`;
  g.nodes.push({ id, type, name, path, lineRange: [line, line + 3], exported });
  qi.name_to_node_ids[name] ??= []; qi.name_to_node_ids[name].push(id);
  qi.path_to_node_ids[path] ??= []; qi.path_to_node_ids[path].push(id);
  return id;
}

describe("binStrategy", () => {
  test("bin pointing at an indexed src file → ep:bin:<name>, certain, tier-1 root", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/cli.ts", "", 1);
    add(g, qi, "function", "src/cli.ts", "main", 4, true);
    const root = tmpPkg({ name: "mytool", bin: { mytool: "src/cli.ts" } });
    const eps = detectEntrypoints(g, qi, root);
    const bin = eps.find((e) => e.source === "bin");
    expect(bin).toMatchObject({ id: "ep:bin:mytool", confidence: "certain", fn: "main", nodeId: "function:src/cli.ts:main" });
  });

  test("bin pointing at dist → remapped, inferred", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/cli.ts", "", 1);
    add(g, qi, "function", "src/cli.ts", "main", 4, true);
    const root = tmpPkg({ name: "t", bin: { t: "dist/cli.js" } });
    const bin = detectEntrypoints(g, qi, root).find((e) => e.source === "bin");
    expect(bin).toMatchObject({ id: "ep:bin:t", confidence: "inferred" });
  });

  test("bin whose file is not indexed → dropped", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    const root = tmpPkg({ name: "t", bin: { t: "dist/ghost.js" } });
    expect(detectEntrypoints(g, qi, root).some((e) => e.source === "bin")).toBe(false);
  });

  test("no repoRoot → bin strategy skipped, no throw", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    expect(() => detectEntrypoints(g, qi)).not.toThrow();
  });
});

describe("scriptStrategy", () => {
  test("scripts.start=node <src file> → ep:script:start, certain", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/server.ts", "", 1);
    // Named "runServer", not "startServer" — the latter is also a daemon-preset
    // candidate name (ROLES), which would collide on nodeId and, post-Task-7
    // dedup, get swallowed by the (never-deduped) preset winner — unrelated to
    // what this test actually exercises (script-command parsing).
    add(g, qi, "function", "src/server.ts", "runServer", 3, true);
    const root = tmpPkg({ name: "s", scripts: { start: "node src/server.ts" } });
    const e = detectEntrypoints(g, qi, root).find((x) => x.source === "script");
    expect(e).toMatchObject({ id: "ep:script:start", confidence: "certain", fn: "runServer" });
  });

  test("opaque scripts (next dev / concurrently) emit nothing", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/index.ts", "", 1);
    const root = tmpPkg({ name: "s", scripts: { start: "next dev", dev: "concurrently 'a' 'b'" } });
    expect(detectEntrypoints(g, qi, root).some((x) => x.source === "script")).toBe(false);
  });
});

describe("frameworkStrategy", () => {
  test("src/index.ts → ep:fw:index, inferred", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/index.ts", "", 1);
    const e = detectEntrypoints(g, qi, undefined).find((x) => x.source === "framework");
    // repoRoot undefined still allows graph-only framework signals:
    expect(e).toMatchObject({ id: "ep:fw:index", source: "framework", confidence: "inferred" });
  });

  test("Next route files → one inferred entry each, capped with a warning", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    for (let i = 0; i < 25; i++) add(g, qi, "file", `app/r${i}/page.tsx`, "", 1);
    const { entrypoints, warnings } = require("../../src/repo-graph/detect-entrypoints")
      .detectEntrypointsWithWarnings(g, qi, undefined);
    const fw = entrypoints.filter((x: { source: string }) => x.source === "framework");
    expect(fw.length).toBe(20);
    expect(warnings.some((w: string) => /omitted/.test(w))).toBe(true);
  });
});

describe("rankAndDedup", () => {
  test("same nodeId: a certain script root beats an inferred (remapped) bin root — confidence first", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/index.ts", "", 1);
    add(g, qi, "function", "src/index.ts", "main", 2, true);
    // bin → dist/index.js (remap = inferred); script start → node src/index.ts (direct = certain).
    // Both resolve to function:src/index.ts:main. The certain script must survive.
    const root = tmpPkg({ name: "app", bin: { app: "dist/index.js" }, scripts: { start: "node src/index.ts" } });
    const forNode = detectEntrypoints(g, qi, root).filter((e) => e.nodeId === "function:src/index.ts:main");
    expect(forNode).toHaveLength(1);
    expect(forNode[0]).toMatchObject({ source: "script", confidence: "certain" });
  });

  test("a preset id is NEVER deduped away, even when a certain generic shares its nodeId (backward compat)", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    // The daemon preset roots at startDaemon; a bin also points at the same file/function.
    add(g, qi, "file", "src/daemon/server.ts", "", 1);
    add(g, qi, "function", "src/daemon/server.ts", "startDaemon", 5, true);
    const root = tmpPkg({ name: "app", bin: { app: "src/daemon/server.ts" } });
    const ids = detectEntrypoints(g, qi, root).map((e) => e.id);
    expect(ids).toContain("daemon"); // bare preset id preserved → ?entry=daemon still resolves
  });

  test("ranking: certain entries come before inferred", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    add(g, qi, "file", "src/cli.ts", "", 1); add(g, qi, "function", "src/cli.ts", "main", 2, true);
    add(g, qi, "file", "app/x/page.tsx", "", 1);
    const root = tmpPkg({ name: "app", bin: { app: "src/cli.ts" } });
    const eps = detectEntrypoints(g, qi, root);
    const firstInferred = eps.findIndex((e) => e.confidence === "inferred");
    const lastCertain = eps.map((e) => e.confidence).lastIndexOf("certain");
    expect(lastCertain).toBeLessThan(firstInferred);
  });
});
