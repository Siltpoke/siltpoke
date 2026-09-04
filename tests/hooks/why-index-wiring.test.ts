// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRecordWhy } from "../../src/hooks/why-index-wiring";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async function seedBaseline(cwd: string, b: object) {
  await mkdir(join(cwd, ".siltpoke"), { recursive: true });
  await writeFile(join(cwd, ".siltpoke", "baseline.json"), JSON.stringify(b));
}

test("writes an index entry from baseline + head, host label threaded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-wire-"));
  await seedBaseline(cwd, { head_sha: "base", session_id: "s1", captured_at: "2026-07-27T00:00:00.000Z" });
  await maybeRecordWhy({ cwd, sessionId: "s1", transcriptPath: "/t/s1.jsonl", host: "claude-code", stopTime: "2026-07-27T01:00:00.000Z",
    runRevParse: async () => ({ exitCode: 0, stdout: "head\n" }),
    runGit: async () => ({ exitCode: 0, stdout: `${SHA_A} 2026-07-27T00:30:00.000Z\n` }) });
  const idx = JSON.parse(await readFile(join(cwd, ".siltpoke", "why-index.json"), "utf8"));
  expect(idx[SHA_A].sessions[0].host).toBe("claude-code");
});

test("skips when baseline head_sha is null (no throw, no file)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-wire-"));
  await seedBaseline(cwd, { head_sha: null, session_id: "s1", captured_at: "2026-07-27T00:00:00.000Z" });
  await maybeRecordWhy({ cwd, sessionId: "s1", transcriptPath: "/t/s1.jsonl", host: "claude-code", stopTime: "2026-07-27T01:00:00.000Z",
    runRevParse: async () => ({ exitCode: 0, stdout: "head\n" }),
    runGit: async () => { throw new Error("must not be called"); } });
  await expect(readFile(join(cwd, ".siltpoke", "why-index.json"), "utf8")).rejects.toThrow();
});

test("skips when baseline.session_id ≠ this session (stale baseline from another session)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-wire-"));
  await seedBaseline(cwd, { head_sha: "base", session_id: "OTHER", captured_at: "2026-07-27T00:00:00.000Z" });
  await maybeRecordWhy({ cwd, sessionId: "s1", transcriptPath: "/t/s1.jsonl", host: "claude-code", stopTime: "2026-07-27T01:00:00.000Z",
    runRevParse: async () => ({ exitCode: 0, stdout: "head\n" }),
    runGit: async () => { throw new Error("must not be called"); } });
  await expect(readFile(join(cwd, ".siltpoke", "why-index.json"), "utf8")).rejects.toThrow();
});

test("all three Stop hooks actually call maybeRecordWhy (wiring not forgotten)", () => {
  for (const f of ["handle-stop.ts", "agy-stop.ts", "codex-stop.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../../src/hooks", f), "utf8");
    expect(src).toContain("maybeRecordWhy");
  }
});
