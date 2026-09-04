// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `makeProjHashResolver` — memoized wrapper around `projHashForCall` (
 * Task 6, carried perf fix from the Task 5 review).
 *
 * `projHashForCall` calls `resolveProjectRoot`, which does a SYNCHRONOUS
 * filesystem walk (readFileSync/statSync up the directory tree). Called
 * once PER RENDERED ROW inside `TimelineScreen`'s `firedRows.map` with no
 * memoization, that's up to 200 sync dir walks per `/timeline` render — even
 * though rows overwhelmingly share a handful of distinct `cwd` values. The
 * fix caches by `cwd` for the duration of one render.
 */
import { describe, expect, test } from "bun:test";
import { makeProjHashResolver } from "../../../../src/web/screens/timeline/proj-hash";

describe("makeProjHashResolver", () => {
  test("invokes the underlying resolver ONCE per DISTINCT cwd, not once per row", () => {
    let calls = 0;
    const fakeResolve = (cwd: string | null): string => {
      calls += 1;
      return cwd ? `hash-${cwd}` : "";
    };
    const resolve = makeProjHashResolver(fakeResolve);

    // 6 rows, only 3 distinct cwds — mirrors a Timeline page where many
    // fired turns share a handful of project cwds.
    const rows = ["/repo/a", "/repo/a", "/repo/b", "/repo/a", "/repo/b", "/repo/c"];
    const results = rows.map((cwd) => resolve(cwd));

    expect(calls).toBe(3); // /repo/a, /repo/b, /repo/c — each resolved once
    expect(results).toEqual([
      "hash-/repo/a",
      "hash-/repo/a",
      "hash-/repo/b",
      "hash-/repo/a",
      "hash-/repo/b",
      "hash-/repo/c",
    ]);
  });

  test("caches a null cwd too — repeated null rows do not re-invoke the resolver", () => {
    let calls = 0;
    const fakeResolve = (cwd: string | null): string => {
      calls += 1;
      return cwd ? `hash-${cwd}` : "";
    };
    const resolve = makeProjHashResolver(fakeResolve);

    expect(resolve(null)).toBe("");
    expect(resolve(null)).toBe("");
    expect(resolve(null)).toBe("");

    expect(calls).toBe(1);
  });

  test("a fresh resolver instance starts with an empty cache (per-render scope)", () => {
    let calls = 0;
    const fakeResolve = (cwd: string | null): string => {
      calls += 1;
      return cwd ? `hash-${cwd}` : "";
    };

    const resolveRenderOne = makeProjHashResolver(fakeResolve);
    resolveRenderOne("/repo/a");
    expect(calls).toBe(1);

    // A second render (new resolver instance) must NOT reuse the first
    // render's cache — each render call gets a fresh memo scope.
    const resolveRenderTwo = makeProjHashResolver(fakeResolve);
    resolveRenderTwo("/repo/a");
    expect(calls).toBe(2);
  });

  test("defaults to the real projHashForCall when no override is supplied", () => {
    const resolve = makeProjHashResolver();
    // Real projHashForCall(null) short-circuits to "" without touching fs.
    expect(resolve(null)).toBe("");
  });
});
