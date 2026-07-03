/** Review BF1 — pre-spawn failures are marked STRUCTURALLY at the spawn site.
 *
 * A `Bun.spawn` throw (claude binary missing → `Executable not found in
 * $PATH` / ENOENT) means the run never reached the paid subprocess — $0
 * billed. providers.ts wraps the spawn + stdin delivery and rethrows as
 * `PreSpawnError` (a named class carrying `preSpawn: true`) so the daemon's
 * failure-path cost ledger can skip these without message-shape matching.
 *
 * Injection point: same as providers-stderr.test.ts — the provider resolves
 * `claude` via PATH with `env: {...process.env}` captured per call, so an
 * empty temp dir as the ONLY PATH entry makes the binary missing for real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPreSpawnError, makeArchBrainProvider, PreSpawnError } from "../../src/explain/providers";

const ORIG_PATH = process.env.PATH;
const tmps: string[] = [];
afterEach(() => {
  process.env.PATH = ORIG_PATH;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("claude -p provider — pre-spawn failures carry the structural marker", () => {
  test("a REAL missing-binary spawn throw arrives as PreSpawnError (not a bare Error)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "no-claude-here-"));
    tmps.push(emptyDir);
    process.env.PATH = emptyDir; // no `claude` anywhere on PATH
    const provider = makeArchBrainProvider();
    let caught: unknown;
    try {
      await provider({ systemPrompt: "s", contextBundle: "c" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PreSpawnError);
    expect(isPreSpawnError(caught)).toBe(true);
    // Original diagnostic preserved for the task record:
    expect((caught as Error).message).toMatch(/never started: .*(Executable not found|ENOENT)/i);
  });

  test("isPreSpawnError: duck-types the structural property, rejects ordinary errors", () => {
    expect(isPreSpawnError(new PreSpawnError("x"))).toBe(true);
    expect(isPreSpawnError({ preSpawn: true })).toBe(true); // cross-module instance
    expect(isPreSpawnError(new Error('Executable not found in $PATH: "claude"'))).toBe(false);
    expect(isPreSpawnError(null)).toBe(false);
    expect(isPreSpawnError("ENOENT")).toBe(false);
  });
});
