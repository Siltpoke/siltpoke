// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("--menubar prints aggregated SwiftBar output", async () => {
  const home = mkdtempSync(join(tmpdir(), "wmb-"));
  const sp = join(home, ".siltpoke");
  mkdirSync(sp, { recursive: true });
  writeFileSync(join(sp, "config.json"), JSON.stringify({ name: "Bangbang", species: "cat" }));
  // Recent timestamps so they fall inside the wrapper's real-clock freshness
  // window (the wrapper uses Date.now(); fixed 2026 timestamps would age out).
  const recent = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString();
  writeFileSync(join(sp, "brain-calls.jsonl"),
    [
      { timestamp: recent(120), session_id: "aaa", cwd: "/x/repo-a", critique_id: "c1", brain_output: { bubble_short: "loop reopens db", severity: "low" }, branch: "feat/x" },
      { timestamp: recent(60), session_id: "bbb", cwd: "/x/repo-b", critique_id: "c2", brain_output: { bubble_short: "await in loop", severity: "high" }, branch: "main" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/face/wrapper.ts"), "--menubar"], {
    env: { ...process.env, HOME: home }, stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("Bangbang · 2"); // plain activity count, no ⚠
  expect(out).not.toContain("⚠");
  // tag = repo · branch · relative-time (no opaque #session)
  expect(out).toContain("repo-a · feat/x · ");
  expect(out).toContain("repo-b · main · ");
  expect(out).not.toContain("#aaa");
  expect(out).not.toContain("#bbb");
  expect(out).toContain("Open dashboard");
});
