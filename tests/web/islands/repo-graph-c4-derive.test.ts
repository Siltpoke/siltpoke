/**
 * Honest-subset C4 derivation (Layer 1).
 *
 * Pins deriveC4FromProjection (projection → C4Model) + layoutC4Bands coord gen:
 * 1:1 container mapping, band-per-group, neutral import edges, no-overlap layout,
 * metamorphic (+subdir → +container), and a siltpoke-shaped golden check.
 */
import { describe, expect, it } from "bun:test";
import {
  bandsByFirstSegment,
  deriveC4FromProjection,
  layoutC4Bands,
  type BandSeed,
  type DerivableProjection,
} from "../../../src/web/client/islands/repo-graph-c4-derive";
import type { C4Node } from "../../../src/web/client/islands/repo-graph-c4-model";

function proj(over: Partial<DerivableProjection> = {}): DerivableProjection {
  return {
    repo: { name: "demo", groupingMode: "semantic" },
    groups: [{ id: "app", title: "App layer", short: "App", accent: "#111" }],
    subdirs: [
      { id: "app", group: "app", files: 5, purpose: "the app", inbound: 0, outbound: 2 },
    ],
    edges: [],
    ...over,
  };
}

describe("deriveC4FromProjection — container mapping", () => {
  it("emits one cont node per subdir (count == subdir count)", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [{ id: "g", title: "G", short: "G", accent: "#1" }],
        subdirs: [
          { id: "a", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 },
          { id: "b", group: "g", files: 2, purpose: "bee", inbound: 1, outbound: 0 },
          { id: "c", group: "g", files: 3, purpose: "", inbound: 0, outbound: 1 },
        ],
      }),
    );
    expect(Object.keys(m.N)).toHaveLength(3);
    for (const id of ["a", "b", "c"]) {
      expect(m.N[id]!.kind).toBe("cont");
      expect(m.N[id]!.title).toBe(id);
      expect(m.N[id]!.drillTo).toBe(id); // drillTo = subdir id → existing drillToFile
    }
  });

  it("desc = purpose when present, undefined when empty (no fabrication)", () => {
    const m = deriveC4FromProjection(proj());
    expect(m.N.app!.desc).toBe("the app");
    const m2 = deriveC4FromProjection(
      proj({
        subdirs: [{ id: "app", group: "app", files: 1, purpose: "", inbound: 0, outbound: 0 }],
      }),
    );
    expect(m2.N.app!.desc).toBeUndefined();
  });

  it("no tech / comp / person / ext on honest-subset nodes", () => {
    const m = deriveC4FromProjection(proj());
    expect(m.N.app!.tech).toBeUndefined();
    expect(m.N.app!.comp).toBeUndefined();
    expect(Object.values(m.N).every((n) => n.kind === "cont")).toBe(true);
  });
});

describe("deriveC4FromProjection — bands + accents", () => {
  it("one band per group with members, label = short uppercased", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [
          { id: "core", title: "Core stuff", short: "Core", accent: "#1" },
          { id: "ui", title: "UI stuff", short: "UI", accent: "#2" },
        ],
        subdirs: [
          { id: "a", group: "core", files: 1, purpose: "", inbound: 0, outbound: 0 },
          { id: "b", group: "ui", files: 1, purpose: "", inbound: 0, outbound: 0 },
        ],
      }),
    );
    expect(m.BANDS).toHaveLength(2);
    expect(m.BANDS.map((b) => b.label)).toEqual(["CORE", "UI"]);
  });

  it("drops empty groups (no member subdirs) from bands", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [
          { id: "core", title: "Core", short: "Core", accent: "#1" },
          { id: "empty", title: "Empty", short: "Empty", accent: "#2" },
        ],
        subdirs: [{ id: "a", group: "core", files: 1, purpose: "", inbound: 0, outbound: 0 }],
      }),
    );
    expect(m.BANDS).toHaveLength(1);
    expect(m.BANDS[0]!.label).toBe("CORE");
  });

  it("cycles the 4 named accents so any group count keeps the palette", () => {
    const groups = Array.from({ length: 6 }, (_, i) => ({
      id: `g${i}`,
      title: `G${i}`,
      short: `G${i}`,
      accent: "#0",
    }));
    const subdirs = groups.map((g) => ({
      id: `s${g.id}`,
      group: g.id,
      files: 1,
      purpose: "",
      inbound: 0,
      outbound: 0,
    }));
    const m = deriveC4FromProjection(proj({ groups, subdirs }));
    const accents = subdirs.map((s) => m.N[s.id]!.accent);
    expect(accents).toEqual(["sky", "terra", "moss", "amber", "sky", "terra"]);
  });
});

describe("deriveC4FromProjection — edges", () => {
  it("maps import edges with a neutral ×weight label", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [{ id: "g", title: "G", short: "G", accent: "#1" }],
        subdirs: [
          { id: "a", group: "g", files: 1, purpose: "", inbound: 0, outbound: 1 },
          { id: "b", group: "g", files: 1, purpose: "", inbound: 1, outbound: 0 },
        ],
        edges: [{ source: "a", target: "b", weight: 7 }],
      }),
    );
    expect(m.E).toEqual([["a", "b", "imports ×7"]]);
  });

  it("filters dangling edges whose endpoints aren't nodes (renderer-safe)", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [{ id: "g", title: "G", short: "G", accent: "#1" }],
        subdirs: [{ id: "a", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 }],
        edges: [
          { source: "a", target: "ghost", weight: 3 },
          { source: "ghost", target: "a", weight: 2 },
        ],
      }),
    );
    expect(m.E).toHaveLength(0);
  });
});

describe("layoutC4Bands — coordinates", () => {
  function rectsOverlap(a: C4Node, b: C4Node): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  it("generates positive bounds enclosing the boundary", () => {
    const m = deriveC4FromProjection(
      proj({
        groups: [{ id: "g", title: "G", short: "G", accent: "#1" }],
        subdirs: [
          { id: "a", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 },
          { id: "b", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 },
        ],
      }),
    );
    expect(m.__bounds.w).toBeGreaterThan(0);
    expect(m.__bounds.h).toBeGreaterThan(0);
    expect(m.__bounds.w).toBeGreaterThanOrEqual(m.BOUNDARY.x + m.BOUNDARY.w);
    expect(m.__bounds.h).toBeGreaterThanOrEqual(m.BOUNDARY.y + m.BOUNDARY.h);
  });

  it("no two container boxes overlap (within or across bands)", () => {
    const groups = [
      { id: "g1", title: "G1", short: "G1", accent: "#1" },
      { id: "g2", title: "G2", short: "G2", accent: "#2" },
    ];
    const subdirs = [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `a${i}`,
        group: "g1",
        files: 1,
        purpose: "",
        inbound: 0,
        outbound: 0,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `b${i}`,
        group: "g2",
        files: 1,
        purpose: "",
        inbound: 0,
        outbound: 0,
      })),
    ];
    const m = deriveC4FromProjection(proj({ groups, subdirs }));
    const ns = Object.values(m.N);
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        expect(rectsOverlap(ns[i]!, ns[j]!)).toBe(false);
      }
    }
  });

  it("layoutC4Bands mutates node coords + returns aligned bands", () => {
    const nodes: Record<string, C4Node> = {
      x: { kind: "cont", title: "x", x: 0, y: 0, w: 0, h: 0 },
      y: { kind: "cont", title: "y", x: 0, y: 0, w: 0, h: 0 },
    };
    const seeds: BandSeed[] = [
      { id: "b1", label: "B1", accent: "sky", note: "n", memberIds: ["x"] },
      { id: "b2", label: "B2", accent: "terra", note: "n", memberIds: ["y"] },
    ];
    const { bands } = layoutC4Bands(seeds, nodes, "demo");
    expect(bands).toHaveLength(2);
    expect(bands[0]!.w).toBe(bands[1]!.w); // all bands align to one width
    expect(bands[1]!.y).toBeGreaterThan(bands[0]!.y); // stacked top→bottom
    expect(nodes.x!.w).toBeGreaterThan(0); // coords filled
  });
});

// ("heuristic layer naming" describe removed — the dir→layer taxonomy
// (layerNameFor) it pinned is gone; degraded bands now label by the verbatim
// first path segment, covered by "degraded first-segment bands" above.)

describe("metamorphic + golden", () => {
  it("adding a subdir adds exactly one container", () => {
    const base = proj({
      groups: [{ id: "g", title: "G", short: "G", accent: "#1" }],
      subdirs: [{ id: "a", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 }],
    });
    const before = Object.keys(deriveC4FromProjection(base).N).length;
    const after = Object.keys(
      deriveC4FromProjection({
        ...base,
        subdirs: [
          ...base.subdirs,
          { id: "z", group: "g", files: 1, purpose: "", inbound: 0, outbound: 0 },
        ],
      }).N,
    ).length;
    expect(after).toBe(before + 1);
  });

  it("golden: a siltpoke-shaped 4-group projection → 4 bands, 4 accents", () => {
    const groups = [
      { id: "surfaces", title: "Surfaces", short: "Surfaces", accent: "#1" },
      { id: "core", title: "Core", short: "Core", accent: "#2" },
      { id: "state", title: "State", short: "State", accent: "#3" },
      { id: "infra", title: "Infra", short: "Infra", accent: "#4" },
    ];
    const subdirs = groups.flatMap((g, gi) =>
      Array.from({ length: 5 }, (_, i) => ({
        id: `${g.id}-${i}`,
        group: g.id,
        files: 3,
        purpose: gi === 0 ? "a surface" : "",
        inbound: gi,
        outbound: 5 - gi,
      })),
    );
    const m = deriveC4FromProjection(proj({ repo: { name: "siltpoke" }, groups, subdirs }));
    expect(m.BOUNDARY.label).toBe("siltpoke");
    expect(m.BANDS).toHaveLength(4);
    expect(Object.keys(m.N)).toHaveLength(20);
    expect(m.BANDS.map((b) => b.label)).toEqual(["SURFACES", "CORE", "STATE", "INFRA"]);
  });
});

// ── degraded first-segment band grouping (honest-subset layout) ───────

describe("bandsByFirstSegment (pure first-segment grouping)", () => {
  it("multi-namespace → one band per first segment, first-appearance order", () => {
    const out = bandsByFirstSegment([
      { id: "ledger", path: "backend/apps/ledger/" },
      { id: "app", path: "frontend/src/app/" },
      { id: "core", path: "backend/apps/core/" },
      { id: "scripts", path: "scripts/" },
    ]);
    expect(out).toEqual([
      { seg: "backend", memberIds: ["ledger", "core"] },
      { seg: "frontend", memberIds: ["app"] },
      { seg: "scripts", memberIds: ["scripts"] },
    ]);
  });

  it("single-root (all same first segment) → exactly ONE band of N", () => {
    const out = bandsByFirstSegment([
      { id: "brain", path: "src/brain/" },
      { id: "chat", path: "src/chat/" },
      { id: "cli", path: "src/cli/" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ seg: "src", memberIds: ["brain", "chat", "cli"] });
  });

  it("reads the segment as opaque data — a path-shaped 'data' dir groups verbatim", () => {
    const out = bandsByFirstSegment([{ id: "x", path: "data/store/" }]);
    expect(out[0]!.seg).toBe("data"); // verbatim, not a 'Data layer' mapping
  });
});

describe("deriveC4FromProjection — degraded first-segment bands", () => {
  function degraded(subdirs: DerivableProjection["subdirs"]): DerivableProjection {
    return {
      repo: { name: "demo", groupingMode: "fallback" },
      groups: [{ id: "g", title: "g", short: "g", accent: "#1" }],
      subdirs,
      edges: [],
    };
  }

  it("fallback + path → bands by first segment, label = segment verbatim", () => {
    const m = deriveC4FromProjection(
      degraded([
        { id: "ledger", group: "g", path: "backend/apps/ledger/", files: 4, purpose: "", inbound: 0, outbound: 0 },
        { id: "app", group: "g", path: "frontend/src/app/", files: 9, purpose: "", inbound: 0, outbound: 0 },
        { id: "scripts", group: "g", path: "scripts/", files: 1, purpose: "", inbound: 0, outbound: 0 },
      ]),
    );
    // verbatim labels (NOT uppercased layer names, NOT 'API'/'UI')
    expect(m.BANDS.map((b) => b.label)).toEqual(["backend", "frontend", "scripts"]);
    // every container still rendered as a node
    expect(Object.keys(m.N).sort()).toEqual(["app", "ledger", "scripts"]);
  });

  it("single-root degraded → ONE band of N (no per-container stack)", () => {
    const m = deriveC4FromProjection(
      degraded([
        { id: "brain", group: "g", path: "src/brain/", files: 1, purpose: "", inbound: 0, outbound: 0 },
        { id: "chat", group: "g", path: "src/chat/", files: 1, purpose: "", inbound: 0, outbound: 0 },
        { id: "cli", group: "g", path: "src/cli/", files: 1, purpose: "", inbound: 0, outbound: 0 },
      ]),
    );
    expect(m.BANDS).toHaveLength(1);
    expect(m.BANDS[0]!.label).toBe("src");
    expect(Object.keys(m.N)).toHaveLength(3); // all 3 in the one band
  });

  it("no band carries the 'by name' heuristic marker (verbatim is data, not a guess)", () => {
    const m = deriveC4FromProjection(
      degraded([
        { id: "ledger", group: "g", path: "backend/apps/ledger/", files: 1, purpose: "", inbound: 0, outbound: 0 },
      ]),
    );
    expect(m.BANDS.every((b) => !b.heuristic)).toBe(true);
  });

  it("path-less fallback (older projection) degrades to supergroup grouping", () => {
    const m = deriveC4FromProjection({
      repo: { name: "demo", groupingMode: "fallback" },
      groups: [{ id: "core", title: "Core", short: "Core", accent: "#1" }],
      subdirs: [{ id: "a", group: "core", files: 1, purpose: "", inbound: 0, outbound: 0 }], // no path
      edges: [],
    });
    expect(m.BANDS).toHaveLength(1);
    expect(m.BANDS[0]!.label).toBe("CORE"); // fell through to g.short — no crash, no layerNameFor
  });

  it("semantic mode ignores path — keeps author supergroups", () => {
    const m = deriveC4FromProjection({
      repo: { name: "demo", groupingMode: "semantic" },
      groups: [{ id: "core", title: "Core", short: "Core", accent: "#1" }],
      subdirs: [
        { id: "a", group: "core", path: "backend/apps/a/", files: 1, purpose: "", inbound: 0, outbound: 0 },
      ],
      edges: [],
    });
    expect(m.BANDS.map((b) => b.label)).toEqual(["CORE"]); // NOT "backend"
  });
});
