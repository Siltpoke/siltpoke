// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Spec 2026-09-14 §5.1: count only what is CERTAINLY outside the root — a
 * relative path that climbs above it, a Python relative import with too many
 * dots, an alias whose every target is above it. A missing file inside the
 * root is a broken import, not an outside one, and must not inflate the count.
 */
import { describe, expect, test } from "bun:test";
import { computeOutsideImports, isOutsideImport } from "../../src/repo-graph/outside-imports";
import type { AnchorMap, RepoGraph } from "../../src/repo-graph/types";

const fileNode = (path: string) => ({ id: `file:${path}:`, type: "file" as const, name: path.split("/").pop()!, path, lineRange: [1, 1] as [number, number] });
const importEdge = (from: string, target: string) => ({ id: `file:${from}:::imports::${target}`, source: `file:${from}:`, target, type: "imports" as const, weight: 1 });
const aliases: AnchorMap = {
  tsAliases: [
    { scopeDir: "", prefix: "@shared/", targets: ["../shared/"] },
    { scopeDir: "", prefix: "@/", targets: ["app/"] },
    { scopeDir: "", prefix: "", targets: [""] }, // baseUrl-only: matches every bare specifier
  ],
  pythonRoots: [],
};

describe("isOutsideImport", () => {
  test("TS relative path climbing above the root → outside", () => {
    expect(isOutsideImport("app/main.ts", "../../shared/util")).toBe(true);
    expect(isOutsideImport("main.ts", "../x")).toBe(true);
  });
  test("TS relative path staying inside the root → not outside (even if the file is missing)", () => {
    expect(isOutsideImport("app/main.ts", "./missing")).toBe(false);
    expect(isOutsideImport("app/main.ts", "../lib/x")).toBe(false);
  });
  test("Python relative with more levels than the file is deep → outside", () => {
    expect(isOutsideImport("py/mod.py", "...shared")).toBe(true); // up 2 from depth 1
    expect(isOutsideImport("py/mod.py", "..sibling")).toBe(false); // up 1 from depth 1 = root
    expect(isOutsideImport("mod.py", ".x")).toBe(false);
  });
  test("Python absolute import → never outside (start dir is unknowable statically)", () => {
    expect(isOutsideImport("py/mod.py", "pkg.mod")).toBe(false);
  });
  test("alias whose targets are all above the root → outside; alias into the root → not", () => {
    expect(isOutsideImport("app/main.ts", "@shared/log", aliases)).toBe(true);
    expect(isOutsideImport("app/main.ts", "@/helper", aliases)).toBe(false);
  });
  test("a bare package never counts, even with a baseUrl-only rule present", () => {
    expect(isOutsideImport("app/main.ts", "react", aliases)).toBe(false);
  });
});

describe("computeOutsideImports", () => {
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileNode("app/main.ts"), fileNode("app/helper.ts"), fileNode("py/mod.py")],
    edges: [
      importEdge("app/main.ts", "../../shared/util"), // outside
      importEdge("app/main.ts", "@shared/log"), // outside (alias)
      importEdge("py/mod.py", "...shared"), // outside (python)
      importEdge("app/main.ts", "./missing"), // inside, missing — NOT counted
      importEdge("app/main.ts", "@/helper"), // resolves — NOT counted
      importEdge("app/main.ts", "react"), // bare — NOT counted
    ],
  };

  test("counts exactly the three certain ones and never lists the broken-inside import", () => {
    const r = computeOutsideImports(graph, aliases);
    expect(r.count).toBe(3);
    expect(r.examples).toEqual(["app/main.ts → ../../shared/util", "app/main.ts → @shared/log", "py/mod.py → ...shared"]);
    expect(r.examples.some((e) => e.includes("./missing"))).toBe(false);
  });

  test("examples are capped at 5 while the count keeps going", () => {
    const many: RepoGraph = {
      schemaVersion: 1,
      nodes: [fileNode("a.ts")],
      edges: Array.from({ length: 7 }, (_, i) => importEdge("a.ts", `../out${i}`)),
    };
    const r = computeOutsideImports(many);
    expect(r.count).toBe(7);
    expect(r.examples).toHaveLength(5);
  });
});
