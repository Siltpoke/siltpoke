// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect, describe } from "bun:test";
import {
  normalizeAgyStop,
  resolveOnStopTarget,
  runAgyStopHook,
  writeStopResponse,
  type AgyReviewSpawnFn,
} from "../../src/hooks/agy-stop";

const REAL_STOP_PAYLOAD = JSON.stringify({
  conversationId: "cfde924e-1234-4abc-9def-000000000001",
  transcriptPath:
    "/Users/x/.gemini/antigravity-cli/brain/cfde924e-1234-4abc-9def-000000000001/.system_generated/logs/transcript_full.jsonl",
  workspacePaths: ["/Users/x/agy-gap-test"],
  artifactDirectoryPath: "/Users/x/.gemini/antigravity-cli/artifacts",
  modelName: "gemini-3.5-flash-low",
  terminationReason: "NO_TOOL_CALL",
  fullyIdle: true,
  executionNum: 0,
  error: "",
});

describe("normalizeAgyStop", () => {
  test("maps conversationId/transcriptPath/workspacePaths[0] to session_id/transcript_path/cwd, tags siltpoke_host", () => {
    const normalized = JSON.parse(normalizeAgyStop(REAL_STOP_PAYLOAD)) as Record<string, unknown>;
    expect(normalized.session_id).toBe("cfde924e-1234-4abc-9def-000000000001");
    expect(normalized.transcript_path).toBe(
      "/Users/x/.gemini/antigravity-cli/brain/cfde924e-1234-4abc-9def-000000000001/.system_generated/logs/transcript_full.jsonl",
    );
    expect(normalized.cwd).toBe("/Users/x/agy-gap-test");
    expect(normalized.siltpoke_host).toBe("antigravity");
    expect(normalized.hook_event_name).toBe("Stop");
    expect(normalized.stop_event_timestamp_ms).toBe(0);
  });

  test("defaults session_id to 'antigravity' and cwd to process.cwd() when fields are absent", () => {
    const normalized = JSON.parse(normalizeAgyStop("{}")) as Record<string, unknown>;
    expect(normalized.session_id).toBe("antigravity");
    expect(normalized.cwd).toBe(process.cwd());
    expect(normalized.transcript_path).toBeUndefined();
    expect(normalized.stop_event_timestamp_ms).toBeUndefined();
  });

  test("malformed JSON input degrades to an empty object instead of throwing", () => {
    expect(() => normalizeAgyStop("not json")).not.toThrow();
    const normalized = JSON.parse(normalizeAgyStop("not json")) as Record<string, unknown>;
    expect(normalized.siltpoke_host).toBe("antigravity");
  });
});

describe("resolveOnStopTarget", () => {
  test("SOURCE install: src/hooks/agy-stop.ts's directory dispatches to its sibling on-stop.ts", () => {
    expect(resolveOnStopTarget("/repo/src/hooks")).toBe("/repo/src/hooks/on-stop.ts");
  });

  test("BUNDLE install: a dist/ directory dispatches to the sibling bundle dist/siltpoke-stop.js, NOT the TS source (which a plugin cache never ships)", () => {
    // Regression coverage for the merge-blocker: dist/agy-stop.js and
    // dist/siltpoke-stop.js are SIBLINGS in the same outdir (scripts/
    // build-dist.ts's BUNDLES list) — the fix is a plain sibling join, no
    // repo-root traversal. Before the fix, the equivalent repo-root math
    // (resolve(here, "..", "..") then join "src/hooks/on-stop.ts") overshot
    // to the PARENT of the plugin root and pointed at a TypeScript source
    // file no plugin install ships.
    expect(resolveOnStopTarget("/Users/x/.claude/plugins/siltpoke/dist")).toBe(
      "/Users/x/.claude/plugins/siltpoke/dist/siltpoke-stop.js",
    );
  });
});

describe("runAgyStopHook", () => {
  function spyStdinSpawn(): {
    spawnFn: AgyReviewSpawnFn;
    calls: {
      cmd: string[];
      env?: Record<string, string | undefined>;
      written: string;
      ended: boolean;
      unrefed: boolean;
    }[];
  } {
    const calls: {
      cmd: string[];
      env?: Record<string, string | undefined>;
      written: string;
      ended: boolean;
      unrefed: boolean;
    }[] = [];
    const spawnFn: AgyReviewSpawnFn = (cmd, opts) => {
      const call = { cmd, env: opts.env, written: "", ended: false, unrefed: false };
      calls.push(call);
      return {
        stdin: {
          write: (chunk: string) => {
            call.written += chunk;
          },
          end: () => {
            call.ended = true;
          },
        },
        unref: () => {
          call.unrefed = true;
        },
      };
    };
    return { spawnFn, calls };
  }

  test("dispatches a detached `bun src/hooks/on-stop.ts` child, pipes the normalized JSON to its stdin, and unrefs it", async () => {
    const { spawnFn, calls } = spyStdinSpawn();
    const { normalized } = await runAgyStopHook({
      rawJson: REAL_STOP_PAYLOAD,
      hereDir: "/repo/src/hooks",
      spawnFn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["bun", "/repo/src/hooks/on-stop.ts"]);
    expect(calls[0]!.written).toBe(normalized);
    expect(calls[0]!.ended).toBe(true);
    expect(calls[0]!.unrefed).toBe(true);
  });

  test("PLUGIN install (hereDir under dist/): dispatches the BUNDLED dist/siltpoke-stop.js, not the TS source a plugin cache never ships", async () => {
    const { spawnFn, calls } = spyStdinSpawn();
    const { normalized } = await runAgyStopHook({
      rawJson: REAL_STOP_PAYLOAD,
      hereDir: "/Users/x/.claude/plugins/siltpoke/dist",
      spawnFn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual([
      "bun",
      "/Users/x/.claude/plugins/siltpoke/dist/siltpoke-stop.js",
    ]);
    expect(calls[0]!.written).toBe(normalized);
    expect(calls[0]!.ended).toBe(true);
    expect(calls[0]!.unrefed).toBe(true);
  });

  test("forces SILTPOKE_SUPPRESSION_ENABLED=1 on the child env so on-stop.ts's marker dedup engages", async () => {
    const { spawnFn, calls } = spyStdinSpawn();
    await runAgyStopHook({
      rawJson: REAL_STOP_PAYLOAD,
      hereDir: "/repo/src/hooks",
      env: { HOME: "/home/x" } as NodeJS.ProcessEnv,
      spawnFn,
    });
    expect(calls[0]!.env?.SILTPOKE_SUPPRESSION_ENABLED).toBe("1");
    expect(calls[0]!.env?.HOME).toBe("/home/x");
  });

  test("an explicit SILTPOKE_SUPPRESSION_ENABLED in the caller's env is NOT overridden", async () => {
    const { spawnFn, calls } = spyStdinSpawn();
    await runAgyStopHook({
      rawJson: REAL_STOP_PAYLOAD,
      hereDir: "/repo/src/hooks",
      env: { SILTPOKE_SUPPRESSION_ENABLED: "0" } as NodeJS.ProcessEnv,
      spawnFn,
    });
    expect(calls[0]!.env?.SILTPOKE_SUPPRESSION_ENABLED).toBe("0");
  });

  test("SILTPOKE_INTERNAL=1: zero spawns (recursion guard fires before dispatch)", async () => {
    const { spawnFn, calls } = spyStdinSpawn();
    await runAgyStopHook({
      rawJson: REAL_STOP_PAYLOAD,
      hereDir: "/repo/src/hooks",
      env: { SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
      spawnFn,
    });
    expect(calls).toHaveLength(0);
  });

  test("a spawn failure is swallowed (fail-soft) — the fast-return promise still resolves", async () => {
    const throwingSpawn: AgyReviewSpawnFn = () => {
      throw new Error("boom");
    };
    await expect(
      runAgyStopHook({ rawJson: REAL_STOP_PAYLOAD, hereDir: "/repo/src/hooks", spawnFn: throwingSpawn }),
    ).resolves.toEqual({ normalized: expect.any(String) });
  });

  test("resolves without waiting on the spawned child (fast return)", async () => {
    const neverBlockingSpawn: AgyReviewSpawnFn = () => ({
      stdin: { write: () => {}, end: () => {} },
      unref: () => {},
    });
    const start = Date.now();
    await runAgyStopHook({ rawJson: REAL_STOP_PAYLOAD, hereDir: "/repo/src/hooks", spawnFn: neverBlockingSpawn });
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("writeStopResponse (agy allow-stop output contract)", () => {
  test("emits exactly `{}` and never the turn-blocking `{\"decision\":\"continue\"}`", () => {
    let written = "";
    writeStopResponse({ write: (chunk: string) => { written += chunk; } });
    expect(written).toBe("{}");
    expect(written).not.toBe('{"decision":"continue"}');
    // Any stdout other than {"decision":"continue"} allows the stop; assert we
    // never accidentally emit that exact turn-blocking string.
    expect(written).not.toContain("continue");
  });
});
