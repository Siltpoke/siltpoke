// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UninstallEffects } from "../../src/cli/plugin-uninstall";
import { fsDiskProbes } from "../../src/cli/uninstall-disk";
import { runUninstallCommand } from "../../src/cli/uninstall-run";
import { markDone, readReceipt, recordBefore } from "../../src/installer/receipt";

// `[61]` PR 2, plan P5.1 (AC20): the report as the CLI prints it, over a real
// temp home — the pure wording is in uninstall-report.test.ts. What is checked
// here is that "removed" follows the disk, in each of the three ways a run ends.

let home: string;
let env: NodeJS.ProcessEnv;
let out: string;
let daemonAnswer: "stopping" | "not-running";
/** A server that outlives its stop and writes the data folder again. */
let writeBack: boolean;

const effects = (): UninstallEffects => ({
  // Like the real one: the unit file is gone afterwards.
  removeAutostart: async () => { rmSync(join(home, "Library", "LaunchAgents", "io.siltpoke.daemon.plist"), { force: true }); return "removed"; },
  stopDaemon: async () => daemonAnswer,
  removeMenubar: async () => ({ shim: false, loginItem: false }),
  codexListsPlugin: () => false,
});

async function run(args: string[], answers: boolean[] | null = null): Promise<number> {
  const left = [...(answers ?? [])];
  out = "";
  return runUninstallCommand(args, env, {
    effects: effects(),
    probes: fsDiskProbes(() => ({ status: 1, stdout: "" }), "darwin", (t) => readReceipt(env)?.entries.some((e) => e.id === t.id) ?? false),
    undo: { exec: () => ({ status: 1, stdout: "" }), platform: "darwin" },
    purge: { run: () => ({ status: 1, stdout: "" }) },
    isTTY: answers !== null,
    ask: async () => left.shift() ?? false,
    write: (t) => {
      out += t;
      // The folder's "deleted" line is printed right after the delete: write into it again, as a live server would.
      if (writeBack && t.includes("(~/.siltpoke): deleted")) {
        mkdirSync(join(home, ".siltpoke"), { recursive: true });
        writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
      }
    },
  });
}

function snapshot(dir: string = home, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) snapshot(p, acc);
    else acc[p] = `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  }
  return acc;
}

const settingsPath = () => join(home, ".claude", "settings.json");
const report = () => out.slice(out.indexOf("Siltpoke uninstall — report"));
const planId = async () => {
  await run(["--plan", "--json"]);
  return (JSON.parse(out) as { planId: string }).planId;
};

/** A recorded status line: the receipt says Siltpoke put it there. */
function recordStatusLine(): void {
  recordBefore(
    { id: "statusline:claude-code", kind: "statusline", target: settingsPath(), byUs: true, level: "uninstall", undo: { type: "restore-statusline" } },
    env,
    { now: new Date("2026-10-03T08:00:00Z") },
  );
  markDone("statusline:claude-code", env);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-uninstall-report-"));
  env = { HOME: home };
  daemonAnswer = "stopping";
  writeBack = false;
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");
  writeFileSync(join(home, ".siltpoke", "config.json"), JSON.stringify({ name: "Velvettwirl", daemon: { enabled: true } }));
  writeFileSync(join(home, ".siltpoke", "siltpoked.pid"), "4242");
  writeFileSync(join(home, "Library", "LaunchAgents", "io.siltpoke.daemon.plist"), "<plist/>");
  writeFileSync(settingsPath(), `${JSON.stringify({ statusLine: { type: "command", command: `sh ${home}/.siltpoke/bin/statusline.sh` }, theme: "dark" })}\n`);
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("the terminal loop ends with the report", () => {
  test("yes to one group, no to the other: one is counted removed, the other is kept by choice, the data waits for --purge", async () => {
    recordStatusLine();
    expect(await run([], [true, false])).toBe(0);
    const r = report();
    expect(r).toContain("Removed: 1 item (1 recorded in the install receipt)");
    expect(r).toMatch(/Kept by your choice:\n {2}\[dashboard\]/);
    expect(r).not.toMatch(/Kept by your choice:[\s\S]*\[claude-code\]/);
    expect(r).toMatch(/Not asked[^\n]*--purge[^\n]*:\n {2}\[user-data\]/);
    expect(r).toContain("started recording what it installs on 2026-10-03");
    expect(r).not.toMatch(/clean/i);
  });

  test("every answer no: zero removed, and the report still comes", async () => {
    expect(await run([], [false, false])).toBe(0);
    expect(report()).toContain("Removed: 0 items");
    expect(report()).toMatch(/Kept by your choice:\n {2}\[claude-code\][\s\S]*\[dashboard\]/);
  });

  test("a server told to stop is counted removed although its pidfile is still there for a moment", async () => {
    expect(await run([], [false, true])).toBe(0);
    expect(existsSync(join(home, ".siltpoke", "siltpoked.pid"))).toBe(true);
    expect(report()).toContain("Removed: 2 items");
    expect(report()).not.toContain("Not removed");
  });

  // Review round 1, F1: "not-running" also means "something answered and it was not safe to stop it".
  test("a server that was not stopped is not counted removed while its pidfile is still there", async () => {
    daemonAnswer = "not-running";
    expect(await run([], [false, true])).toBe(0);
    expect(report()).toContain("Removed: 1 item"); // the start-at-login entry
    expect(report()).toMatch(/Not removed — you said yes[^\n]*:\n {2}- the running dashboard server/);
  });

  // Review round 1, F3: a purge whose folder was written back is not "removed".
  test("a data folder that holds more than the receipt after the delete is not counted removed", async () => {
    recordStatusLine();
    writeBack = true;
    expect(await run(["--purge"], [true, true, true])).toBe(0);
    expect(report()).toMatch(/Not removed — you said yes[^\n]*:\n {2}- your Siltpoke data folder/);
  });

  test("a refused delete is not counted removed even when the folder already holds nothing but the receipt", async () => {
    // What an earlier, kept-receipt purge leaves. The plugin is back, so this delete is refused.
    for (const name of readdirSync(join(home, ".siltpoke"))) rmSync(join(home, ".siltpoke", name), { recursive: true });
    recordBefore({ id: "tool:ollama-model", kind: "outside-tool", target: "nomic-embed-text", byUs: true, level: "purge", undo: { type: "ollama-rm" } }, env);
    writeFileSync(settingsPath(), "{}\n");
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": [{}] } }));
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
    await run(["--purge"], [true, true, true, true]);
    expect(out).toContain("They were NOT deleted");
    expect(report()).toMatch(/Not removed — you said yes[^\n]*:\n[\s\S]*your Siltpoke data folder/);
    expect(report()).not.toMatch(/Removed: [^\n]*\n(?: {2}- [^\n]*\n)*? {2}- your Siltpoke data folder/);
  });

  test("a yes whose removal was refused is 'not removed', never counted — the count follows the disk", async () => {
    // settings.json still points into the folder, so the data folder is refused.
    expect(await run(["--purge"], [false, false, true])).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
    const r = report();
    expect(r).toContain("Removed: 0 items");
    expect(r).toMatch(/Not removed — you said yes[^\n]*:\n {2}- your Siltpoke data folder/);
    // The refusal itself, with what to do first, is printed where the group was answered.
    expect(out.slice(0, out.indexOf("Siltpoke uninstall — report"))).toContain("They were NOT deleted");
  });

  test("the data folder that keeps a trimmed receipt is counted removed, and the receipt's date is the one read before the purge", async () => {
    recordStatusLine();
    // Something of ours that stays on the machine, so the receipt outlives the folder.
    recordBefore({ id: "tool:ollama-model", kind: "outside-tool", target: "nomic-embed-text", byUs: true, level: "purge", undo: { type: "ollama-rm" } }, env);
    markDone("tool:ollama-model", env);
    // claude-code yes, dashboard yes, the model no, the data yes.
    expect(await run(["--purge"], [true, true, false, true])).toBe(0);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
    const r = report();
    expect(r).toMatch(/Removed: 4 items/);
    expect(r).not.toContain("Not removed");
    expect(r).toMatch(/Kept by your choice:\n {2}\[tool:ollama-model\]/);
    expect(r).toContain("2026-10-03");
  });
});

describe("one --remove call", () => {
  test("says what that call removed and how much is left, and the plan id is still the last line", async () => {
    recordStatusLine();
    expect(await run(["--plan-id", await planId(), "--remove", "claude-code"])).toBe(0);
    expect(out).toContain("Removed: 1 item (1 recorded in the install receipt)");
    expect(out).toMatch(/Still on this machine and removable: 3 items\. `uninstall --report`/);
    expect(out).not.toContain("Kept by your choice");
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^plan is now [0-9a-f]{12}$/);
  });
});

describe("uninstall --report", () => {
  test("changes nothing, counts nothing as removed, and lists what is still here without calling it a choice", async () => {
    recordStatusLine();
    const before = snapshot();
    expect(await run(["--report"])).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(out).toContain("Recorded items no longer on this machine: 0");
    expect(out).toMatch(/Still on this machine[^\n]*:\n {2}\[claude-code\]/);
    expect(out).not.toContain("Kept by your choice");
    expect(out).toContain("Not tracked:");
  });

  // Review round 1, F2: this is how `/siltpoke:siltpoke-uninstall` ends — one `--remove` per yes, then `--report`.
  test("after --remove calls it counts what they took, and does not say 'Removed: 0' or 'before this run'", async () => {
    recordStatusLine();
    await run(["--plan-id", await planId(), "--remove", "claude-code"]);
    await run(["--report"]);
    expect(out).toMatch(/Recorded items no longer on this machine: 1\n {2}- Siltpoke's status line in/);
    expect(out).not.toContain("Removed: 0");
    expect(out).not.toContain("before this run");
    expect(out).toContain("never recorded is not counted");
  });

  test.each([
    [["--report", "--remove", "claude-code"]],
    [["--report", "--plan-id", "000000000000"]],
    [["--report", "--plan"]],
  ])("%j is refused: --report only prints", async (args) => {
    const before = snapshot();
    expect(await run(args)).toBe(2);
    expect(out).toContain("--report only prints");
    expect(snapshot()).toEqual(before);
  });

  test("with no receipt it says so and gives no date", async () => {
    await run(["--report"]);
    expect(out).toContain("no install receipt");
    expect(out).not.toContain("started recording");
  });
});
