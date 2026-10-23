// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 — the menu-bar group (spec §2.2, §2.3): the SwiftBar app
// (outside-tool), its PluginDirectory pref (macos-pref), the shim (file) and
// the SwiftBar login item (launch-agent) are each recorded, with byUs observed
// BEFORE the action and `done` only once the action happened.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIM_NAME, runMenubarSetup, SWIFTBAR_APP_PATH } from "../../src/installer/menubar-setup";
import { readReceipt, type ReceiptEntry } from "../../src/installer/receipt";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-menubar-receipt-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const PREF_ID = "pref:com.ameba.SwiftBar.PluginDirectory";
const defaultDir = () => join(home, "Library", "Application Support", "SwiftBar", "plugins");
const loginItem = () => join(home, "Library", "LaunchAgents", "io.siltpoke.swiftbar.plist");
const entry = (id: string): ReceiptEntry | undefined => readReceipt(env)?.entries.find((e) => e.id === id);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface World {
  swiftbar: boolean;
  brewInstallStatus?: number;
  prefWriteStatus?: number;
  pref?: string;
  files?: Record<string, string>;
}

/** A fake Mac: the file map and the pref change as the installer acts on them. */
function fakeMac(w: World) {
  const files: Record<string, string> = { ...(w.files ?? {}) };
  let swiftbar = w.swiftbar;
  let pref = w.pref;
  const execs: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    execs.push([cmd, ...args].join(" "));
    if (cmd === "brew" && args[0] === "list") return { status: swiftbar ? 0 : 1, stdout: "" };
    if (cmd === "brew" && args[0] === "install") {
      const status = w.brewInstallStatus ?? 0;
      if (status === 0) swiftbar = true;
      return { status, stdout: "" };
    }
    if (cmd === "which") return { status: 0, stdout: args[0] === "bun" ? "/opt/bun\n" : "/opt/brew\n" };
    if (cmd === "defaults" && args[0] === "read") return pref ? { status: 0, stdout: `${pref}\n` } : { status: 1, stdout: "" };
    if (cmd === "defaults" && args[0] === "write") {
      const status = w.prefWriteStatus ?? 0;
      if (status === 0) pref = args[3];
      return { status, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
  return {
    files,
    execs,
    deps: {
      platform: "darwin",
      home,
      env,
      exec,
      existsSync: (p: string) => (p === SWIFTBAR_APP_PATH ? swiftbar : p in files),
      writeFile: (p: string, c: string) => {
        files[p] = c;
      },
      readFile: (p: string) => files[p] ?? null,
      rendererPath: "/plugin/dist/siltpoke-card.js",
    },
  };
}

const yes = { readLine: async () => "y", write: () => {} };
const no = { readLine: async () => "n", write: () => {} };

describe("runMenubarSetup → receipt", () => {
  test("fresh Mac: all four are ours and done, with the undo the planner needs", async () => {
    const mac = fakeMac({ swiftbar: false });
    const r = await runMenubarSetup({ io: yes, ...mac.deps });
    expect(r.installed).toBe(true);

    expect(entry("tool:swiftbar")).toMatchObject({
      kind: "outside-tool",
      byUs: true,
      state: "done",
      level: "purge",
      undo: { type: "brew-uninstall-cask", cask: "swiftbar" },
    });
    expect(entry(PREF_ID)).toMatchObject({
      kind: "macos-pref",
      target: "com.ameba.SwiftBar",
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "defaults-delete", domain: "com.ameba.SwiftBar", key: "PluginDirectory" },
    });
    const shim = join(defaultDir(), SHIM_NAME);
    expect(entry(`file:${shim}`)).toMatchObject({
      kind: "file",
      target: shim,
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "remove-if-hash", sha256: sha(mac.files[shim] ?? "missing") },
    });
    expect(entry("launch-agent:swiftbar")).toMatchObject({
      kind: "launch-agent",
      target: loginItem(),
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "unload-and-delete" },
    });
    expect(readReceipt(env)?.entries).toHaveLength(4);
  });

  test("SwiftBar and its pref were already there: both recorded as not ours", async () => {
    const custom = join(home, "my-swiftbar-plugins");
    const mac = fakeMac({ swiftbar: true, pref: custom });
    await runMenubarSetup({ io: yes, ...mac.deps });

    expect(entry("tool:swiftbar")).toMatchObject({ byUs: false, state: "done" });
    expect(entry(PREF_ID)).toMatchObject({ byUs: false, state: "done" });
    expect(mac.execs.some((e) => e.startsWith("brew install"))).toBe(false);
    expect(mac.execs.some((e) => e.startsWith("defaults write"))).toBe(false);
    // the shim goes where SwiftBar reads, and that is the path recorded
    expect(entry(`file:${join(custom, SHIM_NAME)}`)).toMatchObject({ byUs: true, state: "done" });
  });

  test("a file of the user's at the shim path is recorded as not ours", async () => {
    const shim = join(defaultDir(), SHIM_NAME);
    const mac = fakeMac({ swiftbar: true, files: { [shim]: "#!/bin/bash\necho my own plugin\n" } });
    await runMenubarSetup({ io: yes, ...mac.deps });
    expect(entry(`file:${shim}`)).toMatchObject({ byUs: false, state: "done" });
  });

  test("something at the shim path that cannot be read is not ours (unknown is not ours)", async () => {
    const shim = join(defaultDir(), SHIM_NAME);
    const mac = fakeMac({ swiftbar: true, files: { [shim]: "unreadable" } });
    await runMenubarSetup({ io: yes, ...mac.deps, readFile: () => null });
    expect(entry(`file:${shim}`)).toMatchObject({ byUs: false });
  });

  test("an older siltpoke shim (other bun, other renderer) is still ours", async () => {
    const shim = join(defaultDir(), SHIM_NAME);
    const old = '#!/bin/bash\nexec "/usr/local/bin/bun" "/Users/x/siltpoke/src/face/wrapper.ts" --menubar\n';
    const mac = fakeMac({ swiftbar: true, files: { [shim]: old } });
    await runMenubarSetup({ io: yes, ...mac.deps });
    expect(entry(`file:${shim}`)).toMatchObject({ byUs: true, state: "done" });
    expect(mac.files[shim]).not.toBe(old);
  });

  test("brew install fails: the SwiftBar entry stays pending and no login item is recorded", async () => {
    const mac = fakeMac({ swiftbar: false, brewInstallStatus: 1 });
    await runMenubarSetup({ io: yes, ...mac.deps });
    expect(entry("tool:swiftbar")).toMatchObject({ byUs: true, state: "pending" });
    // installSwiftbarAutostart skips when SwiftBar.app is absent: nothing on disk, nothing recorded
    expect(entry("launch-agent:swiftbar")).toBeUndefined();
  });

  test("defaults write fails: the pref entry stays pending, never done", async () => {
    const mac = fakeMac({ swiftbar: true, prefWriteStatus: 1 });
    await runMenubarSetup({ io: yes, ...mac.deps });
    expect(entry(PREF_ID)).toMatchObject({ byUs: true, state: "pending" });
  });

  test("declining records nothing", async () => {
    const mac = fakeMac({ swiftbar: false });
    const r = await runMenubarSetup({ io: no, ...mac.deps });
    expect(r.reason).toBe("declined");
    expect(readReceipt(env)).toBeNull();
  });

  test("a re-run keeps one entry per id and does not turn our pref or app into the user's", async () => {
    const mac = fakeMac({ swiftbar: false });
    await runMenubarSetup({ io: yes, ...mac.deps });
    // second run on the same Mac: SwiftBar, the pref and the shim are all present now
    await runMenubarSetup({ io: yes, ...mac.deps });
    expect(entry("tool:swiftbar")).toMatchObject({ byUs: true, state: "done" });
    expect(entry(PREF_ID)).toMatchObject({ byUs: true, state: "done" });
    expect(readReceipt(env)?.entries).toHaveLength(4);
  });
});
