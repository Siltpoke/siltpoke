// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "bcli-")); mkdirSync(join(home, ".claude"), { recursive: true }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("bootstrap CLI --check", () => {
  test("prints a plan, exits 0, mutates nothing", () => {
    const r = Bun.spawnSync(["bun", "src/cli/bootstrap.ts", "--check"], {
      env: { ...process.env, CLAUDE_HOME: join(home, ".claude") },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().toLowerCase()).toContain("plan");
    expect(readdirSync(join(home, ".claude"))).toHaveLength(0);
  });
});
