// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The diff summary's claude may only read files, like the review's.
 *
 * The summary hands claude the raw diff — text from the reviewed repo — and it
 * ran with every tool, the shell and the user's MCP servers included. Read-only,
 * not no tools: on 8 replayed summary prompts no tools miscounted files 10 of
 * 28 times, read-only 0 of 18, every tool 0 of 28.
 *
 * Asserted through the production route: runDiffSummary → the `extract` role
 * brain (what run-critic injects) → guarded wrapper → claude provider → argv.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallBrainOptions } from "../../../src/brain/brain";
import { makeRoleRawBrain } from "../../../src/brain/role-brain";
import { runDiffSummary } from "../../../src/critic/tools/run-diff-summary";

const DIFF = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-export const A = 1;\n+export const A = 2;\n";
const SUMMARY = {
  intent: "change A", key_changes: ["A is 2"], risks: [], file_count: 1,
  files_with_purpose: [{ path: "x.ts", purpose: "constant" }], source: "haiku",
};

function capturingSpawn(capture: { argv?: string[] }): typeof Bun.spawn {
  const envelope = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify(SUMMARY),
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  ]);
  return ((cmd: string[]) => {
    capture.argv = cmd;
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(envelope).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

describe("diff summary is read-only", () => {
  test("the summary asks for read-only", async () => {
    const seen: CallBrainOptions[] = [];
    await runDiffSummary({
      diffText: DIFF,
      callFn: async (opts) => {
        seen.push(opts);
        return { output: SUMMARY, usage: { input_tokens: 1, output_tokens: 1 } as never };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.readOnly).toBe(true);
  });

  test("through the extract role brain, claude's argv ends read-only with no MCP", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-summary-ro-"));
    const capture: { argv?: string[] } = {};
    try {
      const role = makeRoleRawBrain(home, "extract");
      const r = await runDiffSummary({
        diffText: DIFF,
        callFn: (opts) => role({ ...opts, spawnFn: capturingSpawn(capture) }),
      });
      expect(r?.summary.file_count).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(capture.argv?.[0]).toBe("claude");
    expect(capture.argv?.slice(-3)).toEqual(["--tools", "Read,Grep,Glob", "--strict-mcp-config"]);
  });
});
