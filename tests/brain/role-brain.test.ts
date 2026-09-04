// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoleRawBrain, makeRoleTextBrain } from "../../src/brain/role-brain";

// Minimal fake of `claude -p --output-format json`: emits a JSON array whose
// last event is a `result` carrying the given inner text. Mirrors
// tests/brain/callraw.test.ts's fakeClaudeSpawn; also captures argv so tests
// can assert which --model was actually sent.
function fakeClaudeSpawn(innerResult: string, capture?: { argv?: string[] }) {
  return ((argv: string[]) => {
    if (capture) capture.argv = argv;
    const events = [{ type: "result", result: innerResult, total_cost_usd: 0, usage: {} }];
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(JSON.stringify(events)).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

// Minimal fake of `qodercli -p --output-format json`: a single claude-shaped
// envelope wrapping the given inner result text. Mirrors
// tests/brain/callraw.test.ts's fakeQoderSpawn; also captures argv so tests
// can assert the qoder binary/argv path was taken.
function fakeQoderSpawn(innerResult: string, capture?: { argv?: string[] }) {
  return ((argv: string[]) => {
    if (capture) capture.argv = argv;
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: innerResult,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("makeRoleRawBrain", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "role-brain-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("default config -> claude, extract role, pinned model, returns {output, usage}", async () => {
    const raw = makeRoleRawBrain(home, "extract");
    const envelope = JSON.stringify({ candidates: [] }); // an extract consumer's own shape
    const capture: { argv?: string[] } = {};
    const out = await raw({
      systemPrompt: "task",
      contextBundle: "c",
      spawnFn: fakeClaudeSpawn(envelope, capture),
    });
    expect(out.output).toEqual({ candidates: [] });
    // the fake asserts argv --model == claude-haiku-4-5-20251001 (pinned extract default)
    const modelIdx = capture.argv?.indexOf("--model") ?? -1;
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capture.argv?.[modelIdx + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("routes to the configured extract family", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }),
    );
    const raw = makeRoleRawBrain(home, "extract");
    const envelope = JSON.stringify({ candidates: ["x"] });
    const capture: { argv?: string[] } = {};
    const out = await raw({
      systemPrompt: "task",
      contextBundle: "c",
      spawnFn: fakeQoderSpawn(envelope, capture),
    });
    expect(out.output).toEqual({ candidates: ["x"] });
    // fake qoder spawnFn; assert the qoder binary/argv path was taken (provider.meta.name === "qoder")
    expect(capture.argv?.[0]).toBe("qodercli");
  });
});

describe("makeRoleTextBrain", () => {
  test("returns raw text (for recap), chat role", async () => {
    const home = mkdtempSync(join(tmpdir(), "role-brain-"));
    try {
      const text = makeRoleTextBrain(home, "chat");
      const r = await text({
        systemPrompt: "recap",
        contextBundle: "c",
        spawnFn: fakeClaudeSpawn("one-line recap"),
      });
      expect(r.text).toBe("one-line recap");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
