// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `attachWhy` — slice ④ task 6. Pure unit tests over the injected `lookup`
 * override (no real git-blame/transcript I/O here — that's `why-lookup`'s
 * own test suite; this file only covers the attach/fan-out/degrade layer).
 */
import { test, expect } from "bun:test";
import { attachWhy } from "../../src/daemon/routes/seen-why";

test("maps each delta path to a WhyAnchor via lookup", async () => {
  const out = await attachWhy([{ path: "src/login.ts", status: "changed" }], {
    cwd: "/r",
    lookup: async (_cwd, file) => ({ rung: 1, anchor_scope: "turn", user_ask: `why ${file}`, session_id: "s1", turn_index: 0 }),
  });
  expect(out[0]).toMatchObject({ path: "src/login.ts", why: { rung: 1, user_ask: "why src/login.ts" } });
});

test("a lookup throw degrades THAT row to rung 3, never sinks the whole response", async () => {
  const out = await attachWhy([{ path: "src/a.ts" }, { path: "src/b.ts" }], {
    cwd: "/r",
    lookup: async (_c, file) => {
      if (file === "src/a.ts") throw new Error("boom");
      return { rung: 1, anchor_scope: "turn", user_ask: "ok" };
    },
  });
  expect(out[0]?.why).toMatchObject({ rung: 3, anchor_scope: "none" });
  expect(out[1]?.why).toMatchObject({ rung: 1 });
});

test("preserves every other field on the delta unchanged", async () => {
  const out = await attachWhy([{ path: "src/x.ts", baseline_status: "tracked", body_changed: true }], {
    cwd: "/r",
    lookup: async () => ({ rung: 2, anchor_scope: "session", session_id: "s2", transcript_path: "/t.jsonl" }),
  });
  expect(out[0]).toEqual({
    path: "src/x.ts",
    baseline_status: "tracked",
    body_changed: true,
    why: { rung: 2, anchor_scope: "session", session_id: "s2", transcript_path: "/t.jsonl" },
  });
});

test("empty deltas array resolves to an empty array (no lookup calls)", async () => {
  let calls = 0;
  const out = await attachWhy([], {
    cwd: "/r",
    lookup: async () => {
      calls += 1;
      return { rung: 3, anchor_scope: "none" };
    },
  });
  expect(out).toEqual([]);
  expect(calls).toBe(0);
});

test("defaults to the real lookupWhy when no override is given (degrades gracefully off-repo)", async () => {
  // No git repo at this cwd -> the real lookupWhy's blame call fails and it
  // degrades to rung 3 internally; attachWhy must not throw either way.
  const out = await attachWhy([{ path: "does/not/exist.ts" }], { cwd: "/definitely/not/a/repo" });
  expect(out[0]?.why.rung).toBe(3);
});
