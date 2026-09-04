// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { resolveReviewerCwd } from "../../src/brain/providers/reviewer-cwd";

test("warns (does not silently use process.cwd) when opts.cwd absent", () => {
  const warnings: string[] = [];
  const cwd = resolveReviewerCwd({ cwd: undefined }, (m: string) => warnings.push(m));
  expect(warnings.length).toBe(1);
  expect(cwd).toBe(process.cwd());
});

test("does not warn and returns opts.cwd unchanged when present", () => {
  const warnings: string[] = [];
  const cwd = resolveReviewerCwd({ cwd: "/x" }, (m: string) => warnings.push(m));
  expect(warnings.length).toBe(0);
  expect(cwd).toBe("/x");
});

test("warns and falls back when opts.cwd is empty string (matches old `||` semantics, never spawns cwd: \"\")", () => {
  const warnings: string[] = [];
  const cwd = resolveReviewerCwd({ cwd: "" }, (m: string) => warnings.push(m));
  expect(warnings.length).toBe(1);
  expect(cwd).toBe(process.cwd());
});
