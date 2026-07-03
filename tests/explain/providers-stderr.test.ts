/** stderr-capture hygiene.
 *
 * `makeClaudeProvider` piped the subprocess's stderr and never read it — a
 * failing `claude -p` left only "claude -p exited 1" in the task record, and
 * the diagnosis had to run on inference. The fix drains stderr and appends
 * its tail to the thrown error so it lands in `errorMsg`.
 *
 * Injection point: no src API change — the
 * provider spawns `claude` via PATH lookup with `env: {...process.env}`
 * captured per call, so the tests prepend a temp dir holding a fake `claude`
 * script to PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchBrainProvider } from "../../src/explain/providers";

const ORIG_PATH = process.env.PATH;
const tmps: string[] = [];
afterEach(() => {
  process.env.PATH = ORIG_PATH;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shimClaude(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "claude-shim-"));
  tmps.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${ORIG_PATH}`;
}

describe("claude -p provider — stderr lands in the error message", () => {
  test("non-zero exit carries the stderr tail (no more bare 'exited N')", async () => {
    shimClaude(`echo "FATAL: prompt is too long for the model context window" >&2\nexit 7`);
    const provider = makeArchBrainProvider();
    await expect(
      provider({ systemPrompt: "s", contextBundle: "c" }),
    ).rejects.toThrow(/claude -p exited 7: .*prompt is too long/);
  });

  test("non-zero exit with EMPTY stderr carries the stdout tail, source-labeled", async () => {
    // The real 2026-06-10 claude-code failure: 7-min run, exit 1, stderr empty
    // — `claude -p --output-format json` reports errors on STDOUT. Without the
    // stdout tail the task record says only "exited 1" and diagnosis runs on
    // inference again.
    shimClaude(`echo '{"type":"error","message":"API Error: 400 input length exceeds context window"}'\nexit 1`);
    const provider = makeArchBrainProvider();
    await expect(
      provider({ systemPrompt: "s", contextBundle: "c" }),
    ).rejects.toThrow(/claude -p exited 1: stdout tail: .*API Error: 400/);
  });

  test("non-zero exit with BOTH streams carries both tails, labeled and separable", async () => {
    shimClaude(`echo "warn-on-stderr" >&2\necho "fail-on-stdout"\nexit 3`);
    const provider = makeArchBrainProvider();
    await expect(
      provider({ systemPrompt: "s", contextBundle: "c" }),
    ).rejects.toThrow(/exited 3: stderr tail: warn-on-stderr \| stdout tail: fail-on-stdout/);
  });

  test("zero exit with valid JSON stream is unaffected (stderr drained, not fatal)", async () => {
    const events = JSON.stringify([
      {
        type: "result",
        result: "ok-markdown",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    shimClaude(`echo "harmless warning" >&2\ncat > /dev/null\necho '${events}'`);
    const provider = makeArchBrainProvider();
    const out = await provider({ systemPrompt: "s", contextBundle: "c" });
    expect(out.markdown).toBe("ok-markdown");
    expect(out.usage.total_cost_usd).toBe(0.01);
  });
});
