// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRecordWhy, recordWhyForEvent, resolveWhyHost } from "../../src/hooks/why-index-wiring";

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

// [57] — the label must come from the same source as brain-calls.jsonl's `authorFamily`
// (SILTPOKE_HOST, exported by hooks/stop.sh / hook-guard), not only from the payload stamp that
// just agy + codex normalizers set. Table: [payload stamp, env SILTPOKE_HOST, expected host].
const HOST_TABLE: Array<[string | undefined, string | undefined, string]> = [
  [undefined, "claude", "claude-code"],
  [undefined, "", "claude-code"],
  [undefined, undefined, "claude-code"],
  [undefined, "codebuddy", "codebuddy"],   // the [57] case: no payload stamp, host only in env
  [undefined, "qoder", "qoder"],
  [undefined, "codex", "codex"],
  [undefined, "agy", "antigravity"],       // env family name is "agy", label is "antigravity"
  ["codex", "codex", "codex"],
  ["antigravity", "agy", "antigravity"],
  ["antigravity", undefined, "antigravity"], // payload stamp alone still works
  ["codex", undefined, "codex"],
  [undefined, "somethingelse", "claude-code"],
];
for (const [stamp, envHost, want] of HOST_TABLE) {
  test(`resolveWhyHost(stamp=${stamp}, env=${envHost}) -> ${want}`, () => {
    expect(resolveWhyHost(stamp, envHost)).toBe(want as never);
  });
}
test("a codebuddy host is NOT labelled claude-code (negative)", () => {
  expect(resolveWhyHost(undefined, "codebuddy")).not.toBe("claude-code");
});

// path-derived host (source installs / daemon route carry no usable env) — event beats env.
const PATH_TABLE: Array<[string, string | undefined, string]> = [
  ["/Users/u/.codebuddy/projects/-x/s.jsonl", undefined, "codebuddy"],
  ["/Users/u/.qoder/projects/-x/s.jsonl", undefined, "qoder"],
  ["/Users/u/.claude/projects/-x/s.jsonl", undefined, "claude-code"],
  ["/Users/u/.codex/sessions/2026/s.jsonl", undefined, "codex"],
  ["/Users/u/.gemini/antigravity/brain/s/log.jsonl", undefined, "antigravity"],
  ["C:\\Users\\u\\.codebuddy\\projects\\-x\\s.jsonl", undefined, "codebuddy"],
  ["/Users/u/.claude/projects/-x/s.jsonl", "codebuddy", "claude-code"],   // stale daemon env loses
  ["/Users/u/.claude/projects/-Users-u--codebuddy-app/s.jsonl", undefined, "claude-code"], // encoded cwd is one segment
  ["/somewhere/else/s.jsonl", "codebuddy", "codebuddy"],                   // unknown path -> env
  ["/somewhere/else/s.jsonl", undefined, "claude-code"],
];
for (const [path, envHost, want] of PATH_TABLE) {
  test(`resolveWhyHost(path=${path}, env=${envHost}) -> ${want}`, () => {
    expect(resolveWhyHost(undefined, envHost, path)).toBe(want as never);
  });
}

async function recordedHost(transcriptPath: string, envHost: string | undefined): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "why-evt-"));
  await seedBaseline(cwd, { head_sha: "base", session_id: "s1", captured_at: "2026-07-27T00:00:00.000Z" });
  const stop = new Date().toISOString();
  await recordWhyForEvent({ cwd, transcript_path: transcriptPath }, "s1", envHost ? { SILTPOKE_HOST: envHost } : {},
    { runRevParse: async () => ({ exitCode: 0, stdout: "head\n" }),
      runGit: async () => ({ exitCode: 0, stdout: `${SHA_A} ${new Date(Date.now() - 1000).toISOString()}\n` }) });
  void stop;
  const idx = JSON.parse(await readFile(join(cwd, ".siltpoke", "why-index.json"), "utf8"));
  return idx[SHA_A].sessions[0].host;
}
test("Stop call site: codebuddy transcript, no env -> recorded host codebuddy", async () => {
  expect(await recordedHost("/Users/u/.codebuddy/projects/-x/s1.jsonl", undefined)).toBe("codebuddy");
});
test("Stop call site: env says codebuddy but transcript is under ~/.claude -> claude-code (event wins)", async () => {
  expect(await recordedHost("/Users/u/.claude/projects/-x/s1.jsonl", "codebuddy")).toBe("claude-code");
});
