// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[78]`: the schema codex is handed must be one OpenAI strict structured
 * output accepts. It was not: `truncated` (a `z.record`, added in #692) turns
 * into a JSON Schema with `propertyNames`, and the API answered every codex
 * review with `400 invalid_json_schema` ("'propertyNames' is not permitted").
 * Measured 2026-10-03 on `origin/main` with codex-cli 0.155.1.
 *
 * Reads the file `schemaFilePath()` writes — the bytes that really reach
 * `--output-schema` — and walks every node, so a future field of the same shape
 * reds this test instead of every codex review.
 *
 * The rules are OpenAI's strict-mode requirements, spelled out here rather than
 * derived from our converter, so the test cannot share a bug with it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { schemaFilePath } from "../../../src/brain/providers/codex-schema";

/** Keywords OpenAI strict mode refuses. `propertyNames` is the one measured. */
const FORBIDDEN = ["propertyNames", "patternProperties", "unevaluatedProperties", "dependentSchemas"];

type Node = Record<string, unknown>;

function walk(node: unknown, path: string, visit: (n: Node, p: string) => void): void {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) walk(child, `${path}[${i}]`, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Node, path);
  for (const [key, child] of Object.entries(node as Node)) walk(child, `${path}.${key}`, visit);
}

function schema(): Node {
  return JSON.parse(readFileSync(schemaFilePath(), "utf8")) as Node;
}

test("[78] no node uses a keyword OpenAI strict mode refuses", () => {
  const hits: string[] = [];
  walk(schema(), "$", (n, p) => {
    for (const k of FORBIDDEN) if (k in n) hits.push(`${p}.${k}`);
  });
  expect(hits).toEqual([]);
});

test("[78] every object closes additionalProperties and requires every property", () => {
  const bad: string[] = [];
  let objects = 0;
  walk(schema(), "$", (n, p) => {
    if (n.type !== "object") return;
    objects += 1;
    if (n.additionalProperties !== false) bad.push(`${p}: additionalProperties=${JSON.stringify(n.additionalProperties)}`);
    const keys = Object.keys((n.properties as Node | undefined) ?? {}).sort();
    const required = [...((n.required as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(required)) bad.push(`${p}: required ${required} vs properties ${keys}`);
  });
  expect(objects).toBeGreaterThan(1); // the walk really reached nested objects
  expect(bad).toEqual([]);
});

test("[78] the system-authored fields are not offered to the model; model fields still are", () => {
  const props = Object.keys(schema().properties as Node);
  expect(props).not.toContain("truncated");
  expect(props).not.toContain("repaired");
  // Positive control: the walk is over the real reviewer schema, not an empty one.
  for (const field of ["mood", "pose", "critique_for_claude", "severity", "confidence"]) {
    expect(props).toContain(field);
  }
});
