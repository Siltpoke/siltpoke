/**
 * Defect [40] — the pinned node's OWN source has to reach the model.
 *
 * The chat's target snippet used to be the first 600 bytes of the FILE,
 * whatever was pinned: for a file that is the licence header and the imports;
 * for a function it is a different part of the file. These tests drive the
 * pure core `assembleAnchorContext` with in-memory graphs.
 *
 * Run: bun test tests/chat/anchor-target-source.test.ts
 */
import { describe, expect, test } from "bun:test";
import { assembleAnchorContext } from "../../src/chat/anchor-context";
import type { QueryIndex, RepoGraph, SiltpokeGraphEdge, SiltpokeGraphNode } from "../../src/repo-graph/types";

const PATH = "src/big.ts";
const BIG_FILE = `file:${PATH}:`;
const LATE_FN = `function:${PATH}:lateFn`;

function makeNode(
  id: string,
  type: SiltpokeGraphNode["type"],
  name: string,
  startLine: number,
  endLine: number,
): SiltpokeGraphNode {
  return { id, type, name, path: PATH, lineRange: [startLine, endLine] };
}

function contains(source: string, target: string): SiltpokeGraphEdge {
  return { id: `${source}::contains::${target}`, source, target, type: "contains", weight: 1 };
}

// 40 import lines (well past the old 600-byte cut), a 4-line function at lines
// 41-44, one more line at 45.
const HEAD = Array.from({ length: 40 }, (_, i) => `import { dep${i} } from "./dep${i}";`).join("\n");
const BODY = [
  "export function lateFn(input: string): string {",
  "  const MARK_INSIDE_LATE_FN = input.trim();",
  "  return MARK_INSIDE_LATE_FN;",
  "}",
].join("\n");
const BIG_SRC = `${HEAD}\n${BODY}\nexport const MARK_AT_END_OF_FILE = 1;\n`;

/** The fixture graph; `fileEnd` / `fnEnd` override the recorded last lines. */
function bigGraph(fileEnd = 45, fnEnd = 44): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [makeNode(BIG_FILE, "file", "big.ts", 1, fileEnd), makeNode(LATE_FN, "function", "lateFn", 41, fnEnd)],
    edges: [contains(BIG_FILE, LATE_FN)],
  };
}

const BIG_INDEX: QueryIndex = {
  schemaVersion: 1,
  name_to_node_ids: { lateFn: [LATE_FN], "big.ts": [BIG_FILE] },
  path_to_node_ids: { [PATH]: [BIG_FILE, LATE_FN] },
};

/** Resolve `nodeId` against `graph` with `src` as the file's content. */
async function contextFor(nodeId: string, src = BIG_SRC, graph = bigGraph(), queryIndex = BIG_INDEX) {
  const res = await assembleAnchorContext({
    target: { node_id: nodeId },
    graph,
    queryIndex,
    fingerprints: { schemaVersion: 1, files: {} },
    sourceProvider: async (p) => (p === PATH ? src : null),
  });
  if (res.kind !== "resolved") throw new Error(`fixture did not resolve: ${res.kind}`);
  return res.context;
}

describe("the pinned node's own source reaches the model", () => {
  test("the fixture really puts the function past the old 600-byte cut", () => {
    expect(Buffer.byteLength(HEAD, "utf8")).toBeGreaterThan(600);
  });

  test("pinned FILE: the end of the file is in the context, not just the imports", async () => {
    const c = await contextFor(BIG_FILE);
    expect(c.contextBundle).toContain("MARK_AT_END_OF_FILE");
    expect(c.contextBundle).toContain("MARK_INSIDE_LATE_FN");
    expect(c.truncated).toBe(false);
  });

  test("pinned FUNCTION: its body is in the context, labelled with its own lines", async () => {
    const { contextBundle: bundle } = await contextFor(LATE_FN);
    expect(bundle).toContain("MARK_INSIDE_LATE_FN");
    expect(bundle).toContain("[src/big.ts:41-44]");
    // the slice is the function, not the file: neither the imports above it
    // nor the line below it ride along in the target snippet.
    expect(bundle).not.toContain("import { dep0 }");
    expect(bundle).not.toContain("MARK_AT_END_OF_FILE");
  });
});

describe("recorded lines that no longer fit the file", () => {
  test("lines that run past the end of the file are clamped to the file", async () => {
    const c = await contextFor(LATE_FN, BIG_SRC, bigGraph(45, 400));
    expect(c.contextBundle).toContain("[src/big.ts:41-45]");
    expect(c.contextBundle).toContain("MARK_INSIDE_LATE_FN");
    expect(c.truncated).toBe(false);
  });

  test("lines that are not in the file at all get the file from the top", async () => {
    // the file shrank after it was indexed: lines 41-44 no longer exist.
    const shrunk = "export function lateFn() {\n  return 'MARK_SHRUNK_FILE';\n}\n";
    const c = await contextFor(LATE_FN, shrunk);
    expect(c.contextBundle).toContain("[src/big.ts:1-3]");
    expect(c.contextBundle).toContain("MARK_SHRUNK_FILE");
  });
});

describe("a target over the cap", () => {
  test("one line longer than the cap is cut inside the line, flagged, and still sent", async () => {
    // a minified file: the whole thing is line 1. Kept whole it would pass the
    // target cap and then be dropped as a block by the bundle budget.
    const minified = `const MARK_START_OF_LINE=1;${"x".repeat(60_000)};const MARK_END_OF_LINE=1;`;
    const c = await contextFor(BIG_FILE, minified, bigGraph(1));
    expect(c.contextBundle).toContain("MARK_START_OF_LINE");
    expect(c.contextBundle).not.toContain("MARK_END_OF_LINE");
    expect(c.contextBundle).toMatch(/truncated: line 1 is longer than \d+ bytes/);
    expect(c.truncated).toBe(true);
    expect(c.includedSources).toContain(PATH);
  });

  test("a file too big to send whole says which lines it shows, and is flagged truncated", async () => {
    const filler = Array.from({ length: 2000 }, (_, i) => `export const filler${i} = ${i};`).join("\n");
    const huge = `${filler}\nexport const MARK_PAST_THE_CAP = 1;\n`;
    const { contextBundle: bundle, truncated } = await contextFor(BIG_FILE, huge, bigGraph(2001));
    expect(truncated).toBe(true);
    expect(bundle).toContain("export const filler0 = 0;");
    expect(bundle).not.toContain("MARK_PAST_THE_CAP");
    // the model is told the snippet stops early and where — so it can say
    // "I only see lines 1–N" instead of guessing at the rest.
    expect(bundle).toMatch(/truncated: showing lines 1-\d+ of 1-2001/);
    // cut on a line boundary: the last shown line is a whole statement.
    const shown = bundle.match(/showing lines 1-(\d+) of/);
    expect(shown).not.toBeNull();
    const last = Number(shown?.[1]);
    expect(bundle).toContain(`export const filler${last - 1} = ${last - 1};`);
    expect(bundle).not.toContain(`export const filler${last} = ${last};`);
  });
});

describe("a pinned function's Calls list", () => {
  const OUTSIDE = `function:${PATH}:helperOutside`;
  const INSIDE = `function:${PATH}:helperInside`;
  const PINNED = `function:${PATH}:pinned`;
  const SRC = [
    "export function helperOutside() { return 1; }",
    "export function helperInside() { return 2; }",
    "export function unrelated() { return helperOutside(); }",
    "export function pinned() {",
    "  return helperInside();",
    "}",
    "",
  ].join("\n");
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      makeNode(BIG_FILE, "file", "big.ts", 1, 6),
      makeNode(OUTSIDE, "function", "helperOutside", 1, 1),
      makeNode(INSIDE, "function", "helperInside", 2, 2),
      makeNode(PINNED, "function", "pinned", 4, 6),
    ],
    edges: [contains(BIG_FILE, PINNED)],
  };
  const index: QueryIndex = {
    schemaVersion: 1,
    name_to_node_ids: { helperOutside: [OUTSIDE], helperInside: [INSIDE], pinned: [PINNED] },
    path_to_node_ids: { [PATH]: [BIG_FILE, OUTSIDE, INSIDE, PINNED] },
  };

  test("comes from its own lines, not the rest of the file", async () => {
    const c = await contextFor(PINNED, SRC, graph, index);
    expect(c.contextBundle).toContain("- helperInside [src/big.ts:2]");
    expect(c.contextBundle).not.toContain("helperOutside");
  });
});

describe("defect [77] — the pinned source carries its real file line numbers", () => {
  /** The source block's body lines, i.e. everything between the fences. */
  const fenced = (bundle: string) => bundle.split("```\n")[1] ?? "";

  test("pinned FUNCTION: a snippet from line 41 is numbered 41.., never 1..", async () => {
    const { contextBundle: b } = await contextFor(LATE_FN);
    expect(b).toContain("41| export function lateFn(input: string): string {");
    expect(b).toContain("42|   const MARK_INSIDE_LATE_FN = input.trim();");
    expect(b).toContain("44| }");
    expect(b).not.toMatch(/^1\| /m);
    expect(b).not.toContain("45| ");
  });

  test("pinned FILE: every line carries its own number from 1", async () => {
    const { contextBundle: b } = await contextFor(BIG_FILE);
    expect(b).toContain('1| import { dep0 } from "./dep0";');
    expect(b).toContain("40| import { dep39 }");
    expect(b).toContain("45| export const MARK_AT_END_OF_FILE = 1;");
  });

  test("a numbered cut stops on a whole line, and the note's line number is the last numbered line shown", async () => {
    const filler = Array.from({ length: 2000 }, (_, i) => `export const filler${i} = ${i};`).join("\n");
    const { contextBundle: bundle } = await contextFor(BIG_FILE, `${filler}\n`, bigGraph(2000));
    const last = Number(bundle.match(/showing lines 1-(\d+) of 1-2000/)?.[1]);
    expect(last).toBeGreaterThan(1);
    expect(bundle).toContain(`${last}| export const filler${last - 1} = ${last - 1};`);
    expect(bundle).not.toContain(`${last + 1}| `);
  });

  test("the cap is applied AFTER numbering: gutter bytes count against the 16 KB", async () => {
    // 10-byte lines: unnumbered, 1638 would fit in 16384; the gutter makes it fewer.
    const src = Array.from({ length: 4000 }, () => "x".repeat(9)).join("\n");
    const { contextBundle: bundle } = await contextFor(BIG_FILE, `${src}\n`, bigGraph(4000));
    const last = Number(bundle.match(/showing lines 1-(\d+) of/)?.[1]);
    expect(last).toBeLessThan(1638);
    const body = fenced(bundle).split("\n// …")[0] ?? "";
    const used = Buffer.byteLength(`${body}\n`, "utf8");
    expect(used).toBeLessThanOrEqual(16 * 1024);
    // not under-filled: one more numbered line would have broken the cap
    expect(used + Buffer.byteLength(`${last + 1}| ${"x".repeat(9)}\n`, "utf8")).toBeGreaterThan(16 * 1024);
  });

  test("a single over-long line is numbered too, and its cut stays inside the cap", async () => {
    const minified = `const MARK_START_OF_LINE=1;${"x".repeat(60_000)}`;
    const { contextBundle: b } = await contextFor(BIG_FILE, minified, bigGraph(1));
    expect(b).toContain("1| const MARK_START_OF_LINE=1;");
    const body = fenced(b).split("\n// …")[0] ?? "";
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });
});
