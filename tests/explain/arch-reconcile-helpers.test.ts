// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it, afterAll } from "bun:test";
import { resolveBrainContainerId, matchNodeFamily, scopeExternalsToRepo } from "../../src/explain/arch-reconcile";
import { FAMILY_BINARY_ANCHOR_LINE, FAMILY_BINARY_ANCHOR_TOKEN, type ReviewerExternal } from "../../src/brain/registry";
import { anchoredRepoRoot, foreignRepoRoot, lookalikeRepoRoot, cleanupArchRepoRoots } from "../_shared/arch-repo-root";

const claim = (v: string, file = "x.ts") => ({ value: v, evidence: [{ file, line: 1 }] });
const EXT: ReviewerExternal[] = [
  { family: "codex", bin: "codex", title: "Codex CLI", evidenceFile: "src/brain/registry.ts", evidenceLine: FAMILY_BINARY_ANCHOR_LINE, evidenceToken: FAMILY_BINARY_ANCHOR_TOKEN },
  { family: "agy", bin: "agy", title: "Agy CLI", evidenceFile: "src/brain/registry.ts", evidenceLine: FAMILY_BINARY_ANCHOR_LINE, evidenceToken: FAMILY_BINARY_ANCHOR_TOKEN },
  { family: "qoder", bin: "qodercli", title: "Qoder CLI", evidenceFile: "src/brain/registry.ts", evidenceLine: FAMILY_BINARY_ANCHOR_LINE, evidenceToken: FAMILY_BINARY_ANCHOR_TOKEN },
  { family: "codebuddy", bin: "codebuddy", title: "Codebuddy CLI", evidenceFile: "src/brain/registry.ts", evidenceLine: FAMILY_BINARY_ANCHOR_LINE, evidenceToken: FAMILY_BINARY_ANCHOR_TOKEN },
];

afterAll(cleanupArchRepoRoots);

describe("scopeExternalsToRepo", () => {
  it("rejects a LOOKALIKE repo — right path, wrong line content", () => {
    // Every external cites the same `src/brain/registry.ts`, so a path-only
    // check is one all-or-nothing existsSync on a filename another agent/LLM
    // project could plausibly use. That repo would then get four CLIs citing a
    // line 92 that says something else — the same unverifiable citation this
    // whole pass exists to remove, just for fewer repos.
    expect(scopeExternalsToRepo(EXT, lookalikeRepoRoot())).toEqual([]);
  });

  it("tolerates line-number skew — the token moving does NOT make the repo foreign", () => {
    // `evidenceLine` is compiled into the running binary; the checkout on disk
    // moves independently. Requiring the token on that exact line made siltpoke
    // prune its own correct nodes when reading a sibling checkout (measured
    // 2026-08-21). Deleting real data over a line offset is the worse failure.
    const skewed = EXT.map((e) => ({ ...e, evidenceLine: e.evidenceLine + 40 }));
    expect(scopeExternalsToRepo(skewed, anchoredRepoRoot()).map((e) => e.family))
      .toEqual(["codex", "agy", "qoder", "codebuddy"]);
  });

  it("keeps every external when the repo carries the evidence anchor", () => {
    expect(scopeExternalsToRepo(EXT, anchoredRepoRoot()).map((e) => e.family))
      .toEqual(["codex", "agy", "qoder", "codebuddy"]);
  });
  it("drops every external when the repo does not carry the anchor", () => {
    expect(scopeExternalsToRepo(EXT, foreignRepoRoot())).toEqual([]);
  });
  it("drops every external on a null root — fail closed, never guess", () => {
    expect(scopeExternalsToRepo(EXT, null)).toEqual([]);
  });
  it("filters PER external, not all-or-nothing on the first one", () => {
    // Swap one family's anchor for a path the anchored root does not contain:
    // a short-circuiting implementation would keep all four or drop all four.
    const mixed = EXT.map((e) =>
      e.family === "qoder" ? { ...e, evidenceFile: "src/brain/nowhere.ts" } : e,
    );
    expect(scopeExternalsToRepo(mixed, anchoredRepoRoot()).map((e) => e.family))
      .toEqual(["codex", "agy", "codebuddy"]);
  });
});

describe("resolveBrainContainerId", () => {
  it("picks the container with the most src/brain/ members", () => {
    const doc: any = { boundary: "r", bands: [], edges: [], nodes: [
      { id: "brain", kind: "cont", title: claim("Brain"), band: claim("llm"),
        members: ["src/brain/brain.ts", "src/brain/registry.ts", "src/brain/providers/agy.ts"] },
      { id: "web", kind: "cont", title: claim("Web"), band: claim("surf"), members: ["src/web/x.ts"] },
    ]};
    expect(resolveBrainContainerId(doc)).toBe("brain");
  });
  it("returns null when no container has src/brain/ members", () => {
    const doc: any = { boundary: "r", bands: [], edges: [], nodes: [
      { id: "web", kind: "cont", title: claim("Web"), band: claim("surf"), members: ["src/web/x.ts"] },
    ]};
    expect(resolveBrainContainerId(doc)).toBeNull();
  });
});

describe("matchNodeFamily", () => {
  it("keys on externalFamily FIRST when present (idempotency — a re-read node)", () => {
    // An already-reconciled node whose title is unhelpful but externalFamily is set
    // must still be recognized as covered, else a second pass re-injects a duplicate.
    expect(matchNodeFamily({ id: "x", kind: "ext", title: claim("Code Reviewer"), band: claim("e"),
      externalFamily: "qoder" } as any, EXT)).toBe("qoder");
  });
  it("matches by id token (codex-ext → codex)", () => {
    expect(matchNodeFamily({ id: "codex-ext", kind: "ext", title: claim("Codex CLI"), band: claim("e") } as any, EXT)).toBe("codex");
  });
  it("matches qoder by BIN token ONLY — no 'qoder' anywhere in id/title (isolates the bin path)", () => {
    // id + title deliberately avoid the word 'qoder' so the ONLY signal is the bin
    // token 'qodercli'. This makes the Task-4 swap mutation (drop bin-token match) go RED.
    expect(matchNodeFamily({ id: "prov-1", kind: "ext", title: claim("Provider CLI"), band: claim("e"),
      desc: claim("spawns qodercli -p") } as any, EXT)).toBe("qoder");
  });
  it("matches by dedicated-file evidence path (agy.ts → agy)", () => {
    expect(matchNodeFamily({ id: "x", kind: "ext", title: claim("Antigravity"), band: claim("e"),
      desc: claim("headless", "src/brain/providers/agy.ts") } as any, EXT)).toBe("agy");
  });
  it("does NOT match on shared ccfork-reviewer.ts evidence alone (ambiguous)", () => {
    expect(matchNodeFamily({ id: "prov-x", kind: "ext", title: claim("some cli"), band: claim("e"),
      desc: claim("fork", "src/brain/providers/ccfork-reviewer.ts") } as any, EXT)).toBeNull();
  });
  it("returns null for a non-provider external (ollama)", () => {
    expect(matchNodeFamily({ id: "ollama-ext", kind: "ext", title: claim("Ollama"), band: claim("e") } as any, EXT)).toBeNull();
  });
});
