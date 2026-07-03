/**
 * A/B readout — the ONE shared bucketer that both grounding (A) and drillTo
 * derivation (B) resolve through. Resolution is purely over member FILE PATHS via
 * the REAL structural keyspace (`bucketIdOfPath` over the projection's own subdirs)
 * — never by parsing a container id string, and never by the old depth-2 heuristic.
 *
 * Every resolution is null or an id IN the keyspace — never an
 * out-of-keyspace (depth-2 / file-as-bucket) id (the property that retires the skew).
 * No per-shape branch in the grounding source; resolution is
 * file-path-only (one fold).
 * The old depth-2 skew (a loose file `src/state.ts` → id "state.ts" outside
 * the projection keyspace) is GONE — the structural resolver returns honest-null
 * for a path no projection subdir claims.
 */
import { describe, expect, it } from "bun:test";
import { memberToSubdirId, membersToSubdirIds, makeResolveSubdir } from "../../src/explain/subdir-resolve";
import { projectArchitecture } from "../../src/repo-graph/project-architecture";
import type { ArchNodeDoc } from "../../src/explain/arch-model-schema";
import type { RepoGraph, RepoGraphMeta } from "../../src/repo-graph/types";

// A minimal projection keyspace: three subdirs at different depths.
// src/brain/ id="brain", src/web/client/ id="client", src/state/ id="state"
const SUBDIRS = [
  { id: "brain", path: "src/brain/" },
  { id: "client", path: "src/web/client/" },
  { id: "state", path: "src/state/" },
];

// Real-shape member paths spanning every bucket case the readout must handle.
const SHAPES = [
  "src/brain/brain.ts",             // under brain/   → "brain"
  "src/brain/runner.ts",            // under brain/   → "brain"
  "src/web/client/x.ts",            // under web/client/ → "client"
  "src/web/client/deep/y.ts",       // under web/client/deep/ → "client" (longest-prefix)
  "src/state/index.ts",             // under state/   → "state"
  "src/state.ts",                   // loose file under src/ — NO container claims it → null
  "config.py",                      // top-level loose file — null
  "x",                              // single segment — null
];

describe("memberToSubdirId — resolution stays IN the structural keyspace", () => {
  it("never returns an out-of-keyspace id — every resolution is null or a member of subdirs (the property that retires the skew)", () => {
    // The load-bearing contract post-migration: a member resolves to an id that is
    // actually IN the projection keyspace, or to null — NEVER an out-of-keyspace id.
    // (Asserting `=== bucketIdOfPath(...)` would be tautological — the body IS that
    // call; this asserts the CONTRACT the readout relies on instead.) The concrete
    // depth-2-skew regression — a loose file the old heuristic mapped to an id
    // OUTSIDE the keyspace — is pinned by the block below (src/state.ts → null).
    const keyspace = new Set(SUBDIRS.map((s) => s.id));
    for (const p of SHAPES) {
      const id = memberToSubdirId(p, SUBDIRS);
      if (id !== null) expect(keyspace.has(id)).toBe(true);
    }
  });

  it("resolves a nested file under a structural container to that container's id (arbitrary depth)", () => {
    expect(memberToSubdirId("src/brain/brain.ts", SUBDIRS)).toBe("brain");
    expect(memberToSubdirId("src/web/client/deep/y.ts", SUBDIRS)).toBe("client"); // deeper path under client
  });

  it("returns null for a loose file that no projection subdir claims (honest-null, no depth-2 skew)", () => {
    // src/state.ts is directly under src/ — NOT under src/state/
    // The depth-2 heuristic would return "state.ts"; the structural resolver returns null.
    expect(memberToSubdirId("src/state.ts", SUBDIRS)).toBeNull();
    expect(memberToSubdirId("config.py", SUBDIRS)).toBeNull();
    expect(memberToSubdirId("x", SUBDIRS)).toBeNull();
  });
});

function cont(id: string, members?: string[]): ArchNodeDoc {
  return { id, kind: "cont", title: { value: id, evidence: [] }, band: { value: "b", evidence: [] }, ...(members ? { members } : {}) };
}

describe("makeResolveSubdir — reverse guard: resolution ignores id SHAPE (one fold, no per-shape branch)", () => {
  it("three DIFFERENT id shapes with the SAME member files resolve to the SAME subdir set", () => {
    // comp: split, composite cohesive, and bare — all resolve purely from member
    // file paths, so the id shape is irrelevant. If a per-shape branch existed, these
    // would diverge. (Not three patches, ONE fold.)
    const members = ["src/brain/brain.ts"];
    const r = makeResolveSubdir([cont("comp:brain/runner", members), cont("brain-state", members), cont("brain", members)], SUBDIRS);
    expect(r("comp:brain/runner")).toEqual(["brain"]);
    expect(r("brain-state")).toEqual(["brain"]);
    expect(r("brain")).toEqual(["brain"]);
  });
  it("the grounding source carries NO id-string fold path (retired memberSubdirId / comp: regex)", async () => {
    const src = await Bun.file("src/explain/arch-ground-bands.ts").text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("comp:"); // no id-string parsing remains; resolution is file-path-only
    expect(code).not.toContain("memberSubdirId");
  });
});

describe("makeResolveSubdir / membersToSubdirIds — shape coverage + structural honest-zero", () => {
  it("file under a real structural container → that container's id", () => {
    expect(makeResolveSubdir([cont("brain-cont", ["src/brain/brain.ts"])], SUBDIRS)("brain-cont")).toEqual(["brain"]);
  });
  it("file at arbitrary depth under container → deepest matching container id", () => {
    // src/web/client/deep/y.ts — longest prefix is "src/web/client/" → "client"
    expect(makeResolveSubdir([cont("c", ["src/web/client/deep/y.ts"])], SUBDIRS)("c")).toEqual(["client"]);
  });
  it("multi-subdir cohesive container → DISTINCT set (not collapsed)", () => {
    const r = makeResolveSubdir([cont("mix", ["src/brain/brain.ts", "src/state/index.ts", "src/brain/runner.ts"])], SUBDIRS);
    expect(new Set(r("mix"))).toEqual(new Set(["brain", "state"]));
  });
  it("loose file not claimed by any structural subdir → dropped (honest-null), container contributes nothing", () => {
    // src/state.ts is NOT under src/state/ — no structural container claims it
    expect(makeResolveSubdir([cont("c", ["src/state.ts"])], SUBDIRS)("c")).toEqual([]);
    // mixed: the loose one is dropped, the real one contributes
    expect(membersToSubdirIds(["src/state.ts", "src/brain/brain.ts"], SUBDIRS)).toEqual(["brain"]);
  });
  it("ext/person or members-less node → empty set (honest zero, NOT a silent orphan)", () => {
    expect(makeResolveSubdir([cont("ext-api")], SUBDIRS)("ext-api")).toEqual([]); // no members
    expect(makeResolveSubdir([cont("empty", [])], SUBDIRS)("empty")).toEqual([]); // empty members
    expect(makeResolveSubdir([], SUBDIRS)("unknown-id")).toEqual([]); // id not in nodes
  });
});

describe("memberToSubdirId — readout keyspace ≡ structural projection keyspace (post-migration)", () => {
  const f = (path: string): RepoGraph["nodes"][number] => ({ id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 1] });
  const meta = { schemaVersion: 1, last_indexed_ts: "t", project_root: "/tmp/demo-repo", proj_hash: "deadbeef" } as unknown as RepoGraphMeta;
  // src/state.ts is a LOOSE file directly under the namespace dir (no container).
  const graph: RepoGraph = { schemaVersion: 1, nodes: [f("src/brain/brain.ts"), f("src/critic/run.ts"), f("src/state.ts")], edges: [] };

  it("members under a real derived container resolve INTO the projection keyspace", () => {
    const projection = projectArchitecture(graph, null, meta);
    const subdirs = projection.subdirs.map((s) => ({ id: s.id, path: s.path }));
    const realIds = new Set(projection.subdirs.map((s) => s.id));
    for (const p of ["src/brain/brain.ts", "src/critic/run.ts"]) {
      const id = memberToSubdirId(p, subdirs);
      expect(id).not.toBeNull();
      expect(realIds.has(id!)).toBe(true);
    }
  });

  it("post-migration: a loose top-level file resolves to honest-null (NO depth-2 skew — readout keyspace ≡ structural keyspace)", () => {
    const projection = projectArchitecture(graph, null, meta);
    const subdirs = projection.subdirs.map((s) => ({ id: s.id, path: s.path }));
    const realIds = new Set(projection.subdirs.map((s) => s.id));

    // structural projection DROPS the loose file — no container claims it.
    expect(realIds.has("state.ts")).toBe(false);

    // POST-MIGRATION: the structural resolver returns null (no skew).
    // This is the core behavior change. The old depth-2 code returned "state.ts".
    const id = memberToSubdirId("src/state.ts", subdirs);
    expect(id).toBeNull();
  });

  it("post-migration: the old skew is gone — a member whose depth-2 id ≠ structural id now resolves to structural id", () => {
    // src/brain/brain.ts → depth-2 heuristic: fileToSubdir → "src/brain/" → subdirId → "brain" (coincidentally correct)
    // But src/web/client/x.ts → depth-2: fileToSubdir → "web/client/" doesn't have this path shape.
    // Use a real projection with a src/web/client/ subdir via the aggregator.
    const webGraph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        f("src/brain/brain.ts"),
        f("src/web/client/app.ts"),
        f("src/web/client/deep/helper.ts"),
      ],
      edges: [],
    };
    const projection = projectArchitecture(webGraph, null, meta);
    const subdirs = projection.subdirs.map((s) => ({ id: s.id, path: s.path }));
    // All files under src/brain/ resolve to "brain"
    expect(memberToSubdirId("src/brain/brain.ts", subdirs)).toBe("brain");
    // All files under src/web/client/ resolve to "client" (or "web" if no nested subdir)
    const clientId = memberToSubdirId("src/web/client/app.ts", subdirs);
    expect(clientId).not.toBeNull();
    // It must be IN the projection keyspace
    const realIds = new Set(projection.subdirs.map((s) => s.id));
    expect(realIds.has(clientId!)).toBe(true);
  });
});
