// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-view trust-input converters (task 5): each of the three architecture
 * views (Generated / Authored / Subset) reshaped into `TrustInput`'s
 * `containers`/`edges` shape so `buildTrustMap` (trust-map.ts) can consume
 * any of them. AC9's oracle — `total` comes from the projection's own subdir
 * bucket count, never from the AI's `members.length` — is the one every
 * mutation in Step 5 targets.
 */
import { describe, expect, it } from "bun:test";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import type { ArchitectureProjection } from "../../src/repo-graph/project-architecture";
import {
  authoredContainers,
  authoredEdges,
  generatedContainers,
  generatedEdges,
  notShownFolders,
  subsetContainers,
  subsetEdges,
} from "../../src/repo-graph/trust-inputs";
import type { C4Model } from "../../src/web/client/islands/repo-graph-c4-model";

const proj: ArchitectureProjection = {
  repo: {
    id: "r",
    name: "repo",
    path: "~/repo",
    files: 9,
    symbols: 0,
    edges: 0,
    lastIndexedTs: "2026-09-20T00:00:00Z",
    building: false,
    groupingMode: "fallback",
  },
  groups: [],
  subdirs: [
    { id: "src/a", group: "g", path: "src/a", files: 4, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
    { id: "src/b", group: "g", path: "src/b", files: 2, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
    { id: "docs", group: "g", path: "docs", files: 3, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
    { id: "empty", group: "g", path: "empty", files: 0, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
  ],
  edges: [{ source: "src/a", target: "src/b", weight: 5 }],
};

const graphFiles = ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "README.md", "package.json"];

const doc: ArchModelDoc = {
  boundary: "repo",
  bands: [],
  nodes: [
    {
      id: "a",
      kind: "cont",
      title: { value: "Container A", evidence: [] },
      band: { value: "core", evidence: [] },
      desc: { value: "does a thing", evidence: [] },
      members: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"],
    },
    {
      id: "p",
      kind: "person",
      title: { value: "User", evidence: [] },
      band: { value: "core", evidence: [] },
    },
  ],
  edges: [],
};

describe("generatedContainers (AC9)", () => {
  it("groups memberFiles by subdir; total from subdirs[].files, not members.length", () => {
    const [c] = generatedContainers(doc, proj, graphFiles);
    expect(c).toMatchObject({
      id: "a",
      title: "Container A",
      desc: "does a thing",
      importFiles: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"],
      listedFiles: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"],
      folders: [
        { folder: "src/a", listed: 2, total: 4 },
        { folder: "src/b", listed: 1, total: 2 },
      ],
    });
  });

  it("only kind === cont nodes become containers", () => {
    expect(generatedContainers(doc, proj, graphFiles)).toHaveLength(1);
  });

});

describe("generatedContainers (AC9) — edge cases", () => {
  it("desc defaults to '' when the claim is absent", () => {
    const docNoDesc: ArchModelDoc = {
      ...doc,
      nodes: [{ id: "a", kind: "cont", title: { value: "A", evidence: [] }, band: { value: "core", evidence: [] }, members: [] }],
    };
    expect(generatedContainers(docNoDesc, proj, graphFiles)[0]?.desc).toBe("");
  });

  it("a member outside every subdir buckets to '(repo root)', total = graphFiles with no bucket", () => {
    const rootDoc: ArchModelDoc = {
      ...doc,
      nodes: [
        {
          id: "a",
          kind: "cont",
          title: { value: "A", evidence: [] },
          band: { value: "core", evidence: [] },
          members: ["src/a/x.ts", "README.md"],
        },
      ],
    };
    const [c] = generatedContainers(rootDoc, proj, graphFiles);
    // README.md and package.json both fall outside every subdir prefix.
    expect(c?.folders).toContainEqual({ folder: "(repo root)", listed: 1, total: 2 });
  });

  it("a member in the derived root bucket (path \"\") reads as '(repo root)', not a blank folder", () => {
    const withRoot: ArchitectureProjection = {
      ...proj,
      subdirs: [
        ...proj.subdirs,
        { id: "(root)", group: "(root)", path: "", files: 3, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
      ],
    };
    const rootDoc: ArchModelDoc = {
      ...doc,
      nodes: [
        {
          id: "a",
          kind: "cont",
          title: { value: "A", evidence: [] },
          band: { value: "core", evidence: [] },
          members: ["main.py"],
        },
      ],
    };
    const [c] = generatedContainers(rootDoc, withRoot, graphFiles);
    expect(c?.folders).toEqual([{ folder: "(repo root)", listed: 1, total: 3 }]);
  });

  it("the derived root bucket is never expanded: listing main.py does not hand the box every root file's imports", () => {
    const withRoot: ArchitectureProjection = {
      ...proj,
      subdirs: [
        { id: "(root)", group: "(root)", path: "", files: 2, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
      ],
    };
    const rootDoc: ArchModelDoc = {
      ...doc,
      nodes: [
        { id: "a", kind: "cont", title: { value: "A", evidence: [] }, band: { value: "core", evidence: [] }, members: ["main.py"] },
      ],
    };
    const [c] = generatedContainers(rootDoc, withRoot, ["main.py", "playwright.config.ts"]);
    expect(c?.importFiles).toEqual(["main.py"]);
  });
});

describe("generatedEdges (AC6-AC8 input shape)", () => {
  const doc: ArchModelDoc = {
    boundary: "repo",
    bands: [],
    nodes: [],
    edges: [
      {
        source: "a",
        target: "b",
        verb: { value: "calls", evidence: [{ file: "src/a/x.ts", line: 10 }], tier: "cited" },
      },
      {
        source: "b",
        target: "c",
        verb: { value: "uses", evidence: [] },
      },
    ],
  };

  it("verb from verb.value, tier from verb.tier ?? null, citation from verb.evidence[0]", () => {
    const [e0, e1] = generatedEdges(doc);
    expect(e0).toMatchObject({ source: "a", target: "b", verb: "calls", tier: "cited", citation: { file: "src/a/x.ts", line: 10 } });
    expect(e1).toMatchObject({ source: "b", target: "c", verb: "uses", tier: null, citation: null });
  });
});

describe("authoredContainers / authoredEdges", () => {
  const model: C4Model = {
    N: {
      x: { kind: "cont", title: "X", desc: "d", members: ["src/a", "src/b"], x: 0, y: 0, w: 0, h: 0 },
      y: { kind: "cont", title: "Y", drillTo: "docs", x: 0, y: 0, w: 0, h: 0 },
      z: { kind: "cont", title: "Z", x: 0, y: 0, w: 0, h: 0 },
      p: { kind: "person", title: "Person", x: 0, y: 0, w: 0, h: 0 },
    },
    E: [["x", "y", "reads"]],
    BANDS: [],
    BOUNDARY: { x: 0, y: 0, w: 0, h: 0, label: "repo" },
    GROUP_ACCENT: { sky: "", terra: "", moss: "", amber: "" },
  };

  it("node with members: importFiles = every graphFiles entry bucketed to those ids; listed null", () => {
    const containers = authoredContainers(model, proj, graphFiles);
    const x = containers.find((c) => c.id === "x");
    expect(x).toMatchObject({
      title: "X",
      desc: "d",
      importFiles: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"],
      listedFiles: [],
      folders: [
        { folder: "src/a", listed: null, total: 4 },
        { folder: "src/b", listed: null, total: 2 },
      ],
    });
  });

  it("node with only drillTo → that subdir", () => {
    const y = authoredContainers(model, proj, graphFiles).find((c) => c.id === "y");
    expect(y?.folders).toEqual([{ folder: "docs", listed: null, total: 3 }]);
  });

  it("node with neither members nor drillTo → its own id", () => {
    const z = authoredContainers(model, proj, graphFiles).find((c) => c.id === "z");
    expect(z?.folders).toEqual([{ folder: "z", listed: null, total: 0 }]);
  });

  it("only kind === cont nodes become containers", () => {
    expect(authoredContainers(model, proj, graphFiles)).toHaveLength(3);
  });

  it("authoredEdges carries the raw [source,target,verb] tuple, no tier/citation", () => {
    expect(authoredEdges(model)).toEqual([{ source: "x", target: "y", verb: "reads", tier: null, citation: null }]);
  });
});

// A projection where id !== path (the real shape: `id` is the last path
// segment, `path` is the full repo-relative path — project-architecture.ts's
// `subdirId()`). The shared `proj` fixture above has id === path everywhere,
// which makes a title/id/folder mixup invisible (Important finding, fix
// round 1): the on-screen honest-subset view titles + keys containers by
// `sd.id` (repo-graph-c4-derive.ts:~226, `N[sd.id] = { title: sd.id, ... }`).
const idNeqPathProj: ArchitectureProjection = {
  ...proj,
  subdirs: [
    { id: "a", group: "g", path: "src/a", files: 4, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
    { id: "b", group: "g", path: "src/b", files: 2, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
  ],
  edges: [{ source: "a", target: "b", weight: 5 }],
};

describe("subsetContainers / subsetEdges", () => {
  it("one per subdir with files > 0", () => {
    const containers = subsetContainers(proj);
    expect(containers.map((c) => c.id)).toEqual(["src/a", "src/b", "docs"]);
    expect(containers.find((c) => c.id === "src/a")?.folders).toEqual([{ folder: "src/a", listed: null, total: 4 }]);
  });

  it("id/title come from sd.id (on-screen key), folder stays sd.path", () => {
    const containers = subsetContainers(idNeqPathProj);
    const a = containers.find((c) => c.id === "a");
    expect(a?.id).toBe("a");
    expect(a?.title).toBe("a");
    expect(a?.folders).toEqual([{ folder: "src/a", listed: null, total: 4 }]);
  });

  it("subsetEdges carries proj.edges[].weight as subsetWeight", () => {
    expect(subsetEdges(proj)).toEqual([{ source: "src/a", target: "src/b", verb: "", tier: null, citation: null, subsetWeight: 5 }]);
  });

  it("subsetEdges source/target are in the same id space as container id (id !== path)", () => {
    expect(subsetEdges(idNeqPathProj)).toEqual([{ source: "a", target: "b", verb: "", tier: null, citation: null, subsetWeight: 5 }]);
  });
});

describe("notShownFolders", () => {
  it("returns folders covered by no container, excluding files === 0 subdirs", () => {
    const doc: ArchModelDoc = {
      boundary: "repo",
      bands: [],
      nodes: [
        {
          id: "a",
          kind: "cont",
          title: { value: "A", evidence: [] },
          band: { value: "core", evidence: [] },
          members: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"],
        },
      ],
      edges: [],
    };
    const containers = generatedContainers(doc, proj, graphFiles);
    expect(notShownFolders(proj, containers)).toEqual(["docs"]);
  });

  it("names an uncovered derived root bucket '(repo root)', and counts it covered when a box lists a root file", () => {
    const withRoot: ArchitectureProjection = {
      ...proj,
      subdirs: [
        { id: "src/a", group: "g", path: "src/a", files: 1, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
        { id: "(root)", group: "(root)", path: "", files: 1, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 },
      ],
    };
    const box = (members: string[]): ArchModelDoc => ({
      boundary: "repo",
      bands: [],
      nodes: [{ id: "a", kind: "cont", title: { value: "A", evidence: [] }, band: { value: "core", evidence: [] }, members }],
      edges: [],
    });
    const files = ["src/a/x.ts", "main.py"];
    expect(notShownFolders(withRoot, generatedContainers(box(["src/a/x.ts"]), withRoot, files))).toEqual(["(repo root)"]);
    expect(notShownFolders(withRoot, generatedContainers(box(["src/a/x.ts", "main.py"]), withRoot, files))).toEqual([]);
  });
});
