// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Audit defect `[55]`: the agy doctor row printed "Antigravity not wired"
 * while agy's Stop hook was firing, because it only read the global
 * `~/.gemini/config/hooks.json` and never opened the plugin's own
 * `plugins/siltpoke/hooks.json`.
 *
 * Every path here lives under a temp dir: `agyHooksJsonPath` is pinned, and the
 * plugin root is derived beside it, so the real `~/.gemini` is never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckResult, runAllChecks } from "../../src/cli/doctor";

let root: string;
let cfg: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sp-doctor-agyplugin-"));
  cfg = join(root, "gemini", "config");
  mkdirSync(cfg, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function agyRow(): CheckResult {
  const rows = runAllChecks({
    claudeHome: join(root, ".claude"),
    siltpokeHome: join(root, ".siltpoke"),
    agyHooksJsonPath: join(cfg, "hooks.json"),
  });
  const row = rows.find((r) => /agy/.test(r.name) && /hook/i.test(r.name));
  if (!row) throw new Error("agy row not found");
  return row;
}

function writePluginHooks(body: unknown): void {
  const dir = join(cfg, "plugins", "siltpoke");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hooks.json"), typeof body === "string" ? body : JSON.stringify(body));
}

const SHIPPED = { hooks: { Stop: [{ type: "command", command: "sh ./hooks/agy-stop.sh", timeout: 30 }] } };

describe("doctor agy row — plugin-shipped hook ([55])", () => {
  test("(a) plugin hooks.json only: wired, and the row says it is the plugin", () => {
    writePluginHooks(SHIPPED);
    const r = agyRow();
    expect(r.pass).toBe(true);
    expect(r.status).toBeUndefined();
    expect(r.name).toContain("via the agy plugin");
    expect(r.name).toContain(join(cfg, "plugins", "siltpoke", "hooks.json"));
    expect(`${r.name} ${r.detail ?? ""}`).not.toContain("not wired");
  });

  test("(b) global hooks.json only: still wired, reported as the global file", () => {
    writeFileSync(
      join(cfg, "hooks.json"),
      JSON.stringify({ "siltpoke-review": { Stop: [{ type: "command", command: "bun /x/agy-stop.ts" }] } }),
    );
    const r = agyRow();
    expect(r.pass).toBe(true);
    expect(r.name).toContain("~/.gemini/config/hooks.json");
    expect(r.name).not.toContain("via the agy plugin");
  });

  test("(c) neither: still the informational not-wired row", () => {
    const r = agyRow();
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("not wired");
    expect(r.name).not.toContain("via the agy plugin");
  });

  test("(d) plugin dir present but no agy-stop Stop entry: NOT wired", () => {
    writePluginHooks({ hooks: { Stop: [{ type: "command", command: "echo unrelated" }], SessionStart: [{ type: "command", command: "sh ./hooks/agy-stop.sh" }] } });
    const r = agyRow();
    expect(r.status).toBe("info");
    expect(r.detail).toContain("not wired");
    expect(r.name).not.toContain("via the agy plugin");
  });

  test("(d3) a Stop command that merely mentions agy-stop is NOT wired", () => {
    writePluginHooks({ hooks: { Stop: [{ type: "command", command: "echo agy-stop-disabled" }] } });
    const r = agyRow();
    expect(r.status).toBe("info");
    expect(r.name).not.toContain("via the agy plugin");
  });

  test("(d2) plugin hooks.json unparseable or plugin dir without hooks.json: NOT wired", () => {
    writePluginHooks("{ not json");
    expect(agyRow().detail).toContain("not wired");
    rmSync(join(cfg, "plugins", "siltpoke", "hooks.json"));
    expect(agyRow().detail).toContain("not wired");
  });

  test("(e) global file present but broken, plugin wired: plugin wins (the hook does fire)", () => {
    writeFileSync(join(cfg, "hooks.json"), JSON.stringify({ other: {} }));
    writePluginHooks(SHIPPED);
    const r = agyRow();
    expect(r.pass).toBe(true);
    expect(r.name).toContain("via the agy plugin");
  });

  test("(f) global broken and plugin absent: still red", () => {
    writeFileSync(join(cfg, "hooks.json"), JSON.stringify({ other: {} }));
    expect(agyRow().pass).toBe(false);
  });
});
