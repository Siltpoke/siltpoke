/**
 * Pure tree-data helpers for the trace-root tree picker.
 *
 * Locks two conditions:
 *  1. Leaf function-kind determination = ONE source (`FUNCTION_KIND`), the same
 *     notion of "function" the `/files` badge counts (methods included) — so the
 *     "N fns" badge can never disagree with the expandable leaves.
 *  2. Leaf node-id is built by the SHARED `funcNodeId(path, name)` — the exact
 *     `function:<path>:<name>` the search box produces (its `fnNodeId` delegates to
 *     the same builder), so tree-pick and search-pick of one function trace
 *     identically (same sink).
 */
import { describe, expect, it } from "bun:test";
import {
  FUNCTION_KIND,
  funcNodeId,
  treeSubdirs,
  treeFiles,
  treeFunctions,
} from "../../../src/web/client/islands/repo-graph-trace-tree";

describe("funcNodeId — the one shared trace-root id builder", () => {
  it("builds function:<path>:<name> (char-identical to what the search box produces)", () => {
    expect(funcNodeId("src/cli/doctor.ts", "runDoctor")).toBe("function:src/cli/doctor.ts:runDoctor");
  });
});

describe("FUNCTION_KIND — single source for the leaf kind gate", () => {
  it('is "function" (the node.type / /symbols kind value the badge counts)', () => {
    expect(FUNCTION_KIND).toBe("function");
  });
});

describe("treeFunctions — leaf level (functions only, shared id)", () => {
  const symbols = [
    { name: "runDoctor", kind: "function", line: 5 },
    { name: "checkAll", kind: "function", line: 20 },
    { name: "Doctor", kind: "class", line: 40 },
    { name: "DEFAULT", kind: "symbol", line: 60 },
  ];

  it("keeps ONLY function-kind symbols (hides class/symbol/const)", () => {
    const leaves = treeFunctions(symbols, "src/cli/doctor.ts");
    expect(leaves.map((l) => l.name)).toEqual(["runDoctor", "checkAll"]);
  });

  it("leaf rawNodeId === funcNodeId(filePath, name) — char-identical to search", () => {
    const leaves = treeFunctions(symbols, "src/cli/doctor.ts");
    expect(leaves[0]!.rawNodeId).toBe(funcNodeId("src/cli/doctor.ts", "runDoctor"));
    expect(leaves[0]!.rawNodeId).toBe("function:src/cli/doctor.ts:runDoctor");
  });

  it("carries the line for each leaf", () => {
    const leaves = treeFunctions(symbols, "src/cli/doctor.ts");
    expect(leaves[0]!.line).toBe(5);
  });

  it("a file with 0 functions yields an empty leaf list (drives the '0 fns' / hide path)", () => {
    const noFns = [
      { name: "Config", kind: "class", line: 1 },
      { name: "DEFAULT", kind: "symbol", line: 2 },
    ];
    expect(treeFunctions(noFns, "src/cli/types.ts")).toEqual([]);
  });
});

describe("treeFiles — file rows carry the function-count badge", () => {
  it("maps /files entries to {name, path, functions} (badge = the functions field)", () => {
    const files = [
      { name: "doctor.ts", path: "src/cli/doctor.ts", symbols: 3, functions: 2, loc: 100, desc: "", explainState: "none" },
      { name: "types.ts", path: "src/cli/types.ts", symbols: 2, functions: 0, loc: 30, desc: "", explainState: "none" },
    ];
    expect(treeFiles(files)).toEqual([
      { name: "doctor.ts", path: "src/cli/doctor.ts", functions: 2 },
      { name: "types.ts", path: "src/cli/types.ts", functions: 0 },
    ]);
  });
});

describe("treeSubdirs — top level from the arch projection", () => {
  it("maps projection subdirs to {id, label}", () => {
    const subdirs = [
      { id: "cli", group: "Surfaces", purpose: "x" },
      { id: "brain", group: "Core", purpose: "y" },
    ];
    expect(treeSubdirs(subdirs)).toEqual([
      { id: "cli", label: "cli" },
      { id: "brain", label: "brain" },
    ]);
  });
});
