/**
 * Adding the optional AbortSignal to explain/providers must NOT touch
 * the critic's `claude -p` spawn. Two pins:
 *   (a) structural — the critic path (src/brain/, src/critic/) does NOT import
 *       explain/providers, so the change is unreachable from the critic;
 *   (b) behavioural — makeDefaultBrainProvider called WITHOUT a signal produces
 *       BYTE-IDENTICAL Bun.spawn options (no signal/killSignal key) — today's
 *       exact spawn. With a signal, the keys are added.
 * Breaking the critic = turning one bug into two; these pins make it impossible.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeDefaultBrainProvider,
  makeArchBrainProvider,
} from "../../src/explain/providers";

const repoRoot = join(import.meta.dir, "..", "..");

describe("critic path does not import explain/providers", () => {
  // The critic spawns claude -p via src/brain/brain.ts (its own spawnFn), NOT
  // explain/providers — so an AbortSignal added there is structurally unreachable.
  for (const rel of [
    "src/brain/brain.ts",
    "src/brain/reflection.ts",
    "src/critic/spawn.ts",
  ]) {
    test(`${rel} does not import explain/providers`, () => {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src).not.toContain("explain/providers");
    });
  }
});

describe("no-signal spawn is byte-identical (back-compat)", () => {
  function withSpawnSpy<T>(
    run: (capture: () => Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const orig = Bun.spawn;
    let captured: Record<string, unknown> = {};
    // minimal fake subprocess: stdin sink, stdout = a result-event JSON string,
    // exited 0. `new Response(string)` accepts a string body.
    (Bun as unknown as { spawn: unknown }).spawn = (
      _cmd: string[],
      opts: Record<string, unknown>,
    ) => {
      captured = opts;
      return {
        stdin: { write() {}, end() {} },
        stdout: '[{"type":"result","result":"ok","total_cost_usd":0,"usage":{}}]',
        exited: Promise.resolve(0),
        pid: 4242,
        kill() {},
      };
    };
    return run(() => captured).finally(() => {
      (Bun as unknown as { spawn: unknown }).spawn = orig;
    });
  }

  test("WITHOUT signal → opts have exactly {stdin,stdout,stderr,env}, no signal/killSignal", async () => {
    await withSpawnSpy(async (capture) => {
      const provider = makeDefaultBrainProvider();
      await provider({ systemPrompt: "s", contextBundle: "c" }); // no signal
      const opts = capture();
      expect("signal" in opts).toBe(false);
      expect("killSignal" in opts).toBe(false);
      expect(Object.keys(opts).sort()).toEqual(["env", "stderr", "stdin", "stdout"]);
    });
  });

  test("WITH signal → signal + killSignal:SIGTERM added (opt-in only)", async () => {
    await withSpawnSpy(async (capture) => {
      const provider = makeArchBrainProvider();
      const ac = new AbortController();
      await provider({ systemPrompt: "s", contextBundle: "c", signal: ac.signal });
      const opts = capture();
      expect("signal" in opts).toBe(true);
      expect(opts.killSignal).toBe("SIGTERM");
    });
  });

  test("onSpawn receives the proc handle (pid) for registry SIGKILL escalation", async () => {
    await withSpawnSpy(async () => {
      const provider = makeArchBrainProvider();
      let gotPid: number | undefined;
      await provider({
        systemPrompt: "s",
        contextBundle: "c",
        onSpawn: (proc) => {
          gotPid = proc.pid;
        },
      });
      expect(gotPid).toBe(4242);
    });
  });
});
