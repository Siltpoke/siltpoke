// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../../src/installer/preflight";

const okExec = (_c: string, _a: string[]) => ({ status: 0, stdout: "/x" });
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pf-")); mkdirSync(join(home, ".claude"), { recursive: true }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("preflight", () => {
  test("no settings.json → settingsExisted false, no refuse", () => {
    const r = preflight(okExec, join(home, ".claude"));
    expect(r.settingsExisted).toBe(false);
    expect(r.refuse).toBeNull();
  });

  test("unparseable settings.json → refuse", () => {
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    const r = preflight(okExec, join(home, ".claude"));
    expect(r.refuse).toContain("settings.json");
  });

  test("valid settings.json → settingsOk true, no refuse", () => {
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    const r = preflight(okExec, join(home, ".claude"));
    expect(r.settingsOk).toBe(true);
    expect(r.refuse).toBeNull();
  });
});
