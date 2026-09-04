// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { runBootstrap } from "../../src/cli/bootstrap";
import type { PlcExec } from "../../src/installer/plc-install";
import type { Exec } from "../../src/installer/prereq";

// Hermetic stand-in for the optional project-lifecycle plugin install step —
// without this, runBootstrap's default plcExec shells out to a real `claude`
// binary via Bun.spawnSync, which is absent on a Linux CI runner (and was,
// pre-fix, fatal to the whole bootstrap when absent).
const noopPlcExec: PlcExec = () => ({ status: 0, stdout: "", stderr: "" });

function fakeIO(answers: string[] = []) {
  let i = 0;
  const out: string[] = [];
  return { io: { readLine: async () => answers[i++] ?? "y", write: (s: string) => out.push(s) }, out };
}
// exec: bun/git/claude present (status 0 for their command -v), everything else 0 too
function presentExec(present: string[]): { calls: string[]; exec: Exec } {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const bin = args[args.length - 1];
    if (cmd === "command" || cmd === "where") return { status: present.includes(bin) ? 0 : 1, stdout: "" };
    return { status: 0, stdout: "" };
  };
  return { calls, exec };
}

describe("runBootstrap P2 phases", () => {
  test("claude absent + decline → status no-host, runInstall never called", async () => {
    // P4 inserted a locale prompt + an editor prompt before the claude gate; Task 5's
    // agent-menu multi-select now sits between the editor prompt and the claude gate —
    // pick codex only (claude-code left unselected) so resolveClaudeHost asks the gate,
    // then "n" declines it.
    const { io } = fakeIO(["", "", "2", "n"]); // locale default, editor default, pick codex only, claude gate → no
    const { exec } = presentExec(["bun", "git"]); // no claude
    let ranInstall = false;
    const res = await runBootstrap({
      exec, io, claudeHome: "/tmp/x", platform: "darwin",
      runInstallFn: async () => { ranInstall = true; },
    });
    expect(res.status).toBe("no-host");
    expect(ranInstall).toBe(false);
  });

  test("--check reports agents + plan, mutates nothing (no runInstall)", async () => {
    const { io, out } = fakeIO([]);
    const { exec } = presentExec(["bun", "git", "claude", "codex"]);
    let ranInstall = false;
    const res = await runBootstrap({
      exec, io, claudeHome: "/tmp/x", platform: "darwin", check: true,
      runInstallFn: async () => { ranInstall = true; },
    });
    expect(res.status).toBe("planned");
    expect(ranInstall).toBe(false);
    expect(out.join("")).toMatch(/Claude Code/);
  });

  test("all present → installs; runInstall receives claude-code + codex preset", async () => {
    const { io } = fakeIO([]);
    const { exec } = presentExec(["bun", "git", "claude", "codex"]);
    let seenPreset: string[] | undefined;
    const res = await runBootstrap({
      exec, io, claudeHome: "/tmp/x", platform: "darwin",
      runInstallFn: async (_io, preset) => { seenPreset = preset; },
      plcExecFn: noopPlcExec,
    });
    expect(res.status).toBe("installed");
    expect(seenPreset).toEqual(["claude-code", "codex"]);
  });
});
