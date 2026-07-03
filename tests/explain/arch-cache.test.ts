/**
 * Generated-model cache + integrity gate.
 *
 * Pins: deterministic repo-scope fingerprint, the 5-malformation integrity gate
 * (each rejected, nothing written; good model passes), and the read three-state
 * (fresh / stale / miss + corrupt-file self-heal).
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fingerprints } from "../../src/repo-graph/types";
import {
  archMetaPath,
  archModelPath,
  computeRepoFingerprint,
  readArchModel,
  sanitizeArchModel,
  validateArchIntegrity,
  writeArchModel,
  type ArchModelMeta,
} from "../../src/explain/arch-cache";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

const EV = [{ file: "src/a/x.ts", line: 1 }];
function goodDoc(): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] }],
    nodes: [
      { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
      { id: "b", kind: "cont", title: { value: "B", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "b" },
    ],
    edges: [{ source: "a", target: "b", verb: { value: "uses", evidence: EV } }],
  };
}
const SUBDIRS = new Set(["a", "b"]);
// Structural projection keyspace matching the test fixtures (src/a/ → "a", src/b/ → "b").
const SUBDIR_KS = [{ id: "a", path: "src/a/" }, { id: "b", path: "src/b/" }];

function fp(files: Record<string, string>): Fingerprints {
  return { schemaVersion: 1, files: Object.fromEntries(Object.entries(files).map(([p, s]) => [p, { content_sha256: s, ast_sig: "x" }])) };
}
function meta(over: Partial<ArchModelMeta> = {}): ArchModelMeta {
  return { schemaVersion: 1, fingerprint: "fp1", graphIndexedTs: "ts1", costUsd: 0.4, groundedPct: 80, model: "sonnet", generatedTs: "2026-06-03T00:00:00Z", ...over };
}

// ── fingerprint ──────────────────────────────────────────────────────────────
describe("computeRepoFingerprint", () => {
  it("is deterministic + order-independent (sorted)", () => {
    const a = computeRepoFingerprint(fp({ "z.ts": "111", "a.ts": "222" }));
    const b = computeRepoFingerprint(fp({ "a.ts": "222", "z.ts": "111" }));
    expect(a).toBe(b);
  });
  it("changes when any file content sha changes", () => {
    const a = computeRepoFingerprint(fp({ "a.ts": "111" }));
    const b = computeRepoFingerprint(fp({ "a.ts": "999" }));
    expect(a).not.toBe(b);
  });
});

// ── USE-3 integrity gate: good + 5 malformations ─────────────────────────────
describe("validateArchIntegrity", () => {
  it("passes a well-formed model", () => {
    expect(validateArchIntegrity(goodDoc(), SUBDIRS).ok).toBe(true);
  });

  it("(1) rejects an edge with a missing endpoint", () => {
    const d = goodDoc();
    d.edges = [{ source: "a", target: "ghost", verb: { value: "uses", evidence: EV } }];
    const r = validateArchIntegrity(d, SUBDIRS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("endpoint missing");
  });

  it("(2) rejects a container spanning two bands", () => {
    const d = goodDoc();
    d.bands = [
      { id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] },
      { id: "extra", label: { value: "Extra", evidence: EV }, order: 1, members: ["a"] },
    ];
    const r = validateArchIntegrity(d, SUBDIRS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("spans two bands");
  });

  it("(3) rejects duplicate node ids", () => {
    const d = goodDoc();
    d.nodes.push({ id: "a", kind: "cont", title: { value: "A2", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" });
    const r = validateArchIntegrity(d, SUBDIRS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("dup node id");
  });

  it("(4) a dangling drillTo is ALLOWED by the gate (sanitized, not rejected)", () => {
    const d = goodDoc();
    d.nodes[0]!.drillTo = "nonsense";
    expect(validateArchIntegrity(d, SUBDIRS).ok).toBe(true);
  });

  it("(2c) an ext/person band member is ALLOWED (laid out outside the bands)", () => {
    // live-smoke finding: the LLM legitimately groups an ext node in an
    // "External" band — the renderer places it outside, so it's not a defect.
    const d = goodDoc();
    d.nodes.push({ id: "api", kind: "ext", title: { value: "API", evidence: EV }, band: { value: "core", evidence: EV } });
    d.bands[0]!.members = ["a", "b", "api"];
    expect(validateArchIntegrity(d, SUBDIRS).ok).toBe(true);
  });

  it("V1(A): sanitizeArchModel derives drillTo from members when the LLM's guess misses", () => {
    // A split container whose drillTo names the component (not a subdir) — the
    // members resolve the real subdir ("a"), so it stays drillable.
    const d: ArchModelDoc = {
      boundary: "demo",
      bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["comp:a/engine"] }],
      nodes: [
        { id: "comp:a/engine", kind: "cont", title: { value: "Engine", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "engine", members: ["src/a/engine.ts", "src/a/engine-helpers.ts"] },
      ],
      edges: [],
    };
    const out = sanitizeArchModel(d, new Set(["a", "b"]), [{ id: "a", path: "src/a/" }]);
    expect(out.nodes[0]!.drillTo).toBe("a"); // derived from members' structural subdir
    expect(d.nodes[0]!.drillTo).toBe("engine"); // input not mutated
  });

  it("A/B-readout: members derive the STRUCTURAL keyspace subdir id via bucketIdOfPath, consistent with the edge keyspace", () => {
    // Post-migration: drillTo is now resolved by the structural `bucketIdOfPath`
    // (longest-path-prefix over the real projection subdirs). The projection subdir
    // `a/agents/` claims `a/agents/scraper/Tool.py` → id `agents`. This is the
    // same id the edge keyspace uses, so the readout keyspace no longer diverges.
    const d: ArchModelDoc = {
      boundary: "demo",
      bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["comp:x/scraper"] }],
      nodes: [
        { id: "comp:x/scraper", kind: "cont", title: { value: "Scraper", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "scraper-agent", members: ["a/agents/scraper/Tool.py", "a/agents/scraper/helpers/util.py"] },
      ],
      edges: [],
    };
    // structural keyspace: the projection subdir with id "agents" at path "a/agents/"
    const agentsSubdirs = [{ id: "agents", path: "a/agents/" }];
    expect(sanitizeArchModel(d, new Set(["agents"]), agentsSubdirs).nodes[0]!.drillTo).toBe("agents");
  });

  it("sanitizeArchModel drops a dangling drillTo (container stays, non-drillable)", () => {
    const d = goodDoc();
    d.nodes[0]!.drillTo = "nonsense"; // not in SUBDIRS
    const out = sanitizeArchModel(d, SUBDIRS, SUBDIR_KS);
    expect(out.nodes[0]!.drillTo).toBeUndefined();
    expect(out.nodes[1]!.drillTo).toBe("b"); // valid drillTo kept
    expect(d.nodes[0]!.drillTo).toBe("nonsense"); // input not mutated
  });

  it("(5) rejects an uneven partition (a container in no band)", () => {
    const d = goodDoc();
    d.bands[0]!.members = ["a"]; // b belongs to no band
    const r = validateArchIntegrity(d, SUBDIRS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in no band");
  });

  it("V1: multiple split containers from ONE subdir pass (unique ids, drillTo=subdir)", () => {
    // A flat subdir "a" splits into two grounded components. Each has a unique
    // comp:<subdir>/<name> id, both drillTo the real subdir "a", both sit in a
    // band → the old subdir-bound gate must NOT reject them.
    const d: ArchModelDoc = {
      boundary: "demo",
      bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["comp:a/engine", "comp:a/tools"] }],
      nodes: [
        { id: "comp:a/engine", kind: "cont", title: { value: "Engine", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a", members: ["src/a/engine.ts"] },
        { id: "comp:a/tools", kind: "cont", title: { value: "Tools", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a", members: ["src/a/tools.ts"] },
      ],
      edges: [{ source: "comp:a/engine", target: "comp:a/tools", verb: { value: "uses", evidence: EV } }],
    };
    expect(validateArchIntegrity(d, SUBDIRS).ok).toBe(true);
    // sanitize keeps drillTo="a" for both (it resolves to a real subdir).
    const out = sanitizeArchModel(d, SUBDIRS, SUBDIR_KS);
    expect(out.nodes[0]!.drillTo).toBe("a");
    expect(out.nodes[1]!.drillTo).toBe("a");
  });
});

// ── write (atomic, gated) + read (3 states) ──────────────────────────────────
describe("writeArchModel + readArchModel", () => {
  async function dir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "arch-cache-"));
  }

  it("writes model + meta for a good doc", async () => {
    const d = await dir();
    const r = writeArchModel(d, goodDoc(), meta(), SUBDIRS);
    expect(r.ok).toBe(true);
    expect(existsSync(archModelPath(d))).toBe(true);
    expect(existsSync(archMetaPath(d))).toBe(true);
  });

  it("rejects a malformed doc and writes NOTHING (atomic)", async () => {
    const d = await dir();
    const bad = goodDoc();
    bad.edges = [{ source: "a", target: "ghost", verb: { value: "uses", evidence: EV } }];
    const r = writeArchModel(d, bad, meta(), SUBDIRS);
    expect(r.ok).toBe(false);
    expect(existsSync(archModelPath(d))).toBe(false);
    expect(existsSync(archMetaPath(d))).toBe(false);
  });

  it("miss → null when no file", async () => {
    const d = await dir();
    expect(await readArchModel(d, "fp1", "ts1")).toBeNull();
  });

  it("fresh → stale:false when fingerprint + graph-ts match", async () => {
    const d = await dir();
    writeArchModel(d, goodDoc(), meta({ fingerprint: "fpX", graphIndexedTs: "tsX" }), SUBDIRS);
    const r = await readArchModel(d, "fpX", "tsX");
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(false);
  });

  it("stale → stale:true on a fingerprint mismatch", async () => {
    const d = await dir();
    writeArchModel(d, goodDoc(), meta({ fingerprint: "old", graphIndexedTs: "tsX" }), SUBDIRS);
    const r = await readArchModel(d, "new", "tsX");
    expect(r!.stale).toBe(true);
  });

  it("corrupt model file → null (self-heal as a miss)", async () => {
    const d = await dir();
    writeArchModel(d, goodDoc(), meta(), SUBDIRS);
    await writeFile(archModelPath(d), "{ not valid json");
    expect(await readArchModel(d, "fp1", "ts1")).toBeNull();
  });
});
