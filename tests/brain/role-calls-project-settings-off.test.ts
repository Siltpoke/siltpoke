// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every role-routed claude call (memory, facts, repo summary, diff summary,
 * recap) skips the folder's project settings. The review does not, yet.
 *
 * Why: these calls run in whatever folder their process sits in. A daemon
 * revived by a codex or agy Stop hook sat in that session's project, a folder
 * claude never asked the user to trust, and `claude -p` there ran the folder's
 * `.claude/settings.json` hooks (measured for chat/explain in
 * an internal design note; #1080 closed those).
 *
 * Asserted through the production route: role brain → guarded wrapper →
 * claude provider → argv.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGuardedCallBrain } from "../../src/brain/brain-guarded";
import { buildClaudeArgv } from "../../src/brain/claude-argv";
import { makeClaudeProvider } from "../../src/brain/provider";
import type { BrainRole } from "../../src/brain/brain-config";
import { makeRoleRawBrain, makeRoleTextBrain } from "../../src/brain/role-brain";

function capturingSpawn(capture: { argv?: string[] }, result: string): typeof Bun.spawn {
  const envelope = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", subtype: "success", is_error: false, result,
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

/** The value right after `--setting-sources`, or null when the flag is absent. */
function settingSources(argv: readonly string[]): string | null {
  const i = argv.indexOf("--setting-sources");
  return i === -1 ? null : (argv[i + 1] ?? "");
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-role-settings-"));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("buildClaudeArgv — projectSettingsOff", () => {
  test("off by default: no --setting-sources", () => {
    expect(settingSources(buildClaudeArgv("m", []))).toBeNull();
    expect(settingSources(buildClaudeArgv("m", [], true))).toBeNull();
  });

  test("on: --setting-sources user, and the tool list stays the tail", () => {
    const argv = buildClaudeArgv("m", [], true, true);
    expect(settingSources(argv)).toBe("user");
    expect(argv.slice(-3)).toEqual(["--tools", "Read,Grep,Glob", "--strict-mcp-config"]);
  });
});

describe("role-routed calls reach claude with project settings off", () => {
  for (const role of ["extract", "chat"] as const satisfies readonly BrainRole[]) {
    test(`raw ${role} call`, async () => {
      const capture: { argv?: string[] } = {};
      await withHome(async (home) => {
        await makeRoleRawBrain(home, role)({ systemPrompt: "sp", contextBundle: "cb", spawnFn: capturingSpawn(capture, "{}") });
      });
      expect(capture.argv?.[0]).toBe("claude");
      expect(settingSources(capture.argv ?? [])).toBe("user");
    });

    test(`text ${role} call`, async () => {
      const capture: { argv?: string[] } = {};
      await withHome(async (home) => {
        await makeRoleTextBrain(home, role)({ systemPrompt: "sp", contextBundle: "cb", spawnFn: capturingSpawn(capture, "hi") });
      });
      expect(settingSources(capture.argv ?? [])).toBe("user");
    });
  }

  test("a caller cannot turn it back on", async () => {
    const capture: { argv?: string[] } = {};
    await withHome(async (home) => {
      await makeRoleRawBrain(home, "extract")({
        systemPrompt: "sp", contextBundle: "cb", projectSettingsOff: false, spawnFn: capturingSpawn(capture, "{}"),
      });
    });
    expect(settingSources(capture.argv ?? [])).toBe("user");
  });
});

describe("the review keeps project settings (for now)", () => {
  // The review is not role-routed: it goes guarded wrapper → claude provider.
  // It is the one call whose only view of a project's CLAUDE.md is claude
  // loading it, so turning this off changes what the review sees — a separate,
  // measured change, not part of this one.
  test("guarded review call: no --setting-sources", async () => {
    const capture: { argv?: string[] } = {};
    await withHome(async (home) => {
      const call = makeGuardedCallBrain({ homeBase: home, provider: makeClaudeProvider(), checkBudgetFn: async () => true });
      // `{}` is not a review, so the call rejects after the spawn; only the argv matters here.
      await call({ systemPrompt: "sp", contextBundle: "cb", readOnly: true, spawnFn: capturingSpawn(capture, "{}") }).catch(() => {});
    });
    expect(capture.argv?.[0]).toBe("claude");
    expect(settingSources(capture.argv ?? [])).toBeNull();
  });
});
