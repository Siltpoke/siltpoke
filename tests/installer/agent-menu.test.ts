// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import type { AgentPresence } from "../../src/installer/agent-detect";
import {
  buildAgentChoices,
  filterPresetByPresence,
  selectAndInstallAgents,
} from "../../src/installer/agent-menu";
import type { Exec } from "../../src/installer/prereq";
import type { WizardIO } from "../../src/installer/wizard";

const bare: AgentPresence = {
  claude: false,
  codex: false,
  codebuddy: false,
  qodercli: false,
  antigravity: false,
  antigravityApp: false,
};

describe("buildAgentChoices", () => {
  test("SPECS assembled from registry: every listed agent is now supported (agy joined the registry)", () => {
    const items = buildAgentChoices({
      claude: true, codex: true, codebuddy: true, qodercli: true, antigravity: true, antigravityApp: false,
    }).items;
    const byValue = Object.fromEntries(items.map((i) => [i.value, i]));
    expect(byValue["claude-code"].supported).toBe(true);
    expect(byValue["codex"].supported).toBe(true);
    expect(byValue["codebuddy"].supported).toBe(true);
    expect(byValue["qodercli"].supported).toBe(true);
    expect(byValue["antigravity"].supported).toBe(true);
  });

  test("every registry-driven agent renders the ✅ supported label (no 🔜 placeholders remain)", () => {
    const { items } = buildAgentChoices(bare);
    for (const i of items) {
      expect(i.supported).toBe(true);
      expect(i.label).toContain("✅");
    }
  });

  test("present + supported agents are pre-checked as defaults", () => {
    const { defaults } = buildAgentChoices({ ...bare, claude: true });
    expect(defaults).toContain("claude-code");
  });

  // NOTE: the "present-but-unsupported agent is not a default" case (once
  // exercised via antigravity) has no live SPECS example left now that agy
  // joined the registry as supported:true — every listed agent is wireable.
  // The underlying filter (`s.supported && presence[s.presentKey]`) is still
  // in buildAgentChoices; re-add a fixture-level test here if a future
  // detect-only placeholder is reintroduced.

  test("codebuddy + qoder are now supported (✅) in the menu", () => {
    const { items } = buildAgentChoices({ ...bare, claude: true, codebuddy: true, qodercli: true });
    const cb = items.find((i) => i.value === "codebuddy");
    const q = items.find((i) => i.value === "qodercli");
    expect(cb?.supported).toBe(true);
    expect(q?.supported).toBe(true);
    expect(cb?.label).toContain("✅");
  });
});

function io(answers: string[]): { io: WizardIO; out: string[] } {
  let i = 0;
  const out: string[] = [];
  return { io: { readLine: async () => answers[i++] ?? "", write: (s) => out.push(s) }, out };
}
const okExec: Exec = () => ({ status: 0, stdout: "" });

describe("selectAndInstallAgents", () => {
  test("claude present, default selection → preset [claude-code], no exit", async () => {
    const p = { ...bare, claude: true };
    const r = await selectAndInstallAgents({ presence: p, io: io([""]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).toEqual(["claude-code"]);
  });

  test("claude + codex present, default → preset includes codex", async () => {
    const p = { ...bare, claude: true, codex: true };
    const r = await selectAndInstallAgents({ presence: p, io: io([""]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.presetAgents).toEqual(["claude-code", "codex"]);
  });

  test("agy selected alone (no claude) still hits the mandatory-claude gate → decline → exit no-host", async () => {
    // antigravity is supported now, so it SURVIVES the picker filter — but
    // claude-code is siltpoke's mandatory anchor regardless of which other
    // hosts are selected (resolveClaudeHost). Picking only item 5
    // (antigravity) with claude absent still prompts "install Claude Code
    // now?"; declining still exits with no host wired.
    const p = { ...bare, antigravity: true };
    const r = await selectAndInstallAgents({ presence: p, io: io(["5", "n"]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(true);
    expect(r.presetAgents).toEqual([]);
  });

  test("bare + select claude-code → installs claude, preset [claude-code]", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "" }; };
    // pick item 1 (claude-code)
    const r = await selectAndInstallAgents({ presence: bare, io: io(["1"]).io, exec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).toEqual(["claude-code"]);
    expect(calls.some((c) => c.args.join(" ").includes("claude.ai/install.sh"))).toBe(true);
  });

  test("selecting an installed antigravity host alongside claude wires BOTH into presetAgents (agy is no longer 🔜)", async () => {
    const p = { ...bare, claude: true, antigravity: true };
    // pick claude-code (1) + antigravity (5)
    const r = await selectAndInstallAgents({ presence: p, io: io(["1,5"]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.presetAgents).toContain("claude-code");
    expect(r.presetAgents).toContain("antigravity");
  });

  test("selecting antigravity while it is NOT actually present (agy CLI missing) does not wire it", async () => {
    const p = { ...bare, claude: true, antigravity: false };
    // pick claude-code (1) + antigravity (5) — selected but absent
    const r = await selectAndInstallAgents({ presence: p, io: io(["1,5"]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.presetAgents).toEqual(["claude-code"]);
  });

  test("claude present but NOT selected → confirm 'keep it?' → decline → exit no-host", async () => {
    const p = { ...bare, claude: true, codex: true };
    // pick codex only (2); claude-code present but unselected → "keep it?" gate → decline
    const r = await selectAndInstallAgents({ presence: p, io: io(["2", "n"]).io, exec: okExec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(true);
    expect(r.presetAgents).toEqual([]);
  });

  test("claude selected + absent, install FAILS → exit:false, preset still includes claude-code", async () => {
    // Inject an Exec that fails on the claude install bash command
    const failingExec: Exec = (cmd, args) => {
      if (cmd === "bash" && args.some((a) => a.includes("claude.ai/install.sh"))) {
        return { status: 1, stdout: "" }; // Non-zero = install failed
      }
      return { status: 0, stdout: "" }; // Other commands (detectPrereqs checks) succeed
    };
    // bare = no agents present; pick item 1 (claude-code)
    const { io: fio, out } = io(["1"]);
    const r = await selectAndInstallAgents({ presence: bare, io: fio, exec: failingExec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(false); // Non-fatal: continue even though claude install failed
    expect(r.presetAgents).toContain("claude-code"); // claude-code still in preset despite install failure
    expect(out.join("")).toMatch(/did not succeed|Continuing/i); // Verify the warning was written
  });

  test("codex selected + absent + npm present → installCodex runs, codex ends in preset", async () => {
    // Setup: claude present (no need to install), codex absent (will try to install)
    const p = { ...bare, claude: true };
    const calls: Array<{ cmd: string; args: string[] }> = [];
    // Inject an Exec that succeeds for all commands (node detection, npm detection, npm install)
    const exec: Exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "" };
    };
    // pick items 1,2 (claude-code, codex)
    const r = await selectAndInstallAgents({ presence: p, io: io(["1,2"]).io, exec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).toEqual(["claude-code", "codex"]);
    // Verify npm install was called
    expect(calls.some((c) => c.cmd === "npm" && c.args.includes("install"))).toBe(true);
  });

  test("codex selected + absent + npm install FAILS → codex dropped from preset, warns", async () => {
    // Setup: claude present, codex absent
    const p = { ...bare, claude: true };
    const { io: fio, out } = io(["1,2"]);
    // Inject an Exec that:
    // - returns 0 for node/npm detection checks (so we try to install)
    // - returns non-zero specifically for "npm install" (the codex install fails)
    const failingNpmExec: Exec = (cmd, args) => {
      if (cmd === "npm" && args.includes("install") && args.includes("@openai/codex")) {
        return { status: 1, stdout: "" }; // npm install -g @openai/codex fails
      }
      return { status: 0, stdout: "" }; // node/npm detection succeeds
    };
    const r = await selectAndInstallAgents({ presence: p, io: fio, exec: failingNpmExec, platform: "darwin", locale: "en" });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).toEqual(["claude-code"]); // codex dropped from preset
    expect(out.join("")).toMatch(/did not succeed|skipping/i); // Verify the warning was written
  });

  test("selected + present codebuddy/qoder survive into presetAgents", async () => {
    // SPECS order: claude-code(1), codex(2), codebuddy(3), qodercli(4), antigravity(5)
    const p = { ...bare, claude: true, codebuddy: true, qodercli: true };
    const r = await selectAndInstallAgents({
      presence: p,
      io: io(["1,3,4"]).io,
      exec: okExec,
      platform: "darwin",
      locale: "en",
    });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).toContain("codebuddy");
    expect(r.presetAgents).toContain("qodercli");
    expect(r.presetAgents).toContain("claude-code");
  });

  test("selected but ABSENT codebuddy is NOT wired into presetAgents", async () => {
    // SPECS order: claude-code(1), codex(2), codebuddy(3), qodercli(4), antigravity(5)
    // codebuddy is selected but presence.codebuddy is false — siltpoke does not
    // install CC-fork hosts, so a selected-but-absent host must be excluded.
    const p = { ...bare, claude: true };
    const r = await selectAndInstallAgents({
      presence: p,
      io: io(["1,3"]).io,
      exec: okExec,
      platform: "darwin",
      locale: "en",
    });
    expect(r.exit).toBe(false);
    expect(r.presetAgents).not.toContain("codebuddy");
    expect(r.presetAgents).toContain("claude-code");
  });
});

describe("resolveAgentFlag", () => {
  test("friendly aliases resolve to canonical ids", () => {
    const { resolveAgentFlag } = require("../../src/installer/agent-menu");
    const r = resolveAgentFlag("agy,qoder,claude");
    expect(r).toEqual({ ok: true, agents: ["antigravity", "qodercli", "claude-code"] });
  });

  test("canonical ids pass through; dedupes", () => {
    const { resolveAgentFlag } = require("../../src/installer/agent-menu");
    const r = resolveAgentFlag("codex, codex ,codebuddy");
    expect(r).toEqual({ ok: true, agents: ["codex", "codebuddy"] });
  });

  test("unknown token → error listing valid names", () => {
    const { resolveAgentFlag } = require("../../src/installer/agent-menu");
    const r = resolveAgentFlag("codex,foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("foo");
    if (!r.ok) expect(r.error).toContain("claude");
  });

  test("empty csv → error", () => {
    const { resolveAgentFlag } = require("../../src/installer/agent-menu");
    expect(resolveAgentFlag("").ok).toBe(false);
  });
});

describe("filterPresetByPresence (Fix 1, final-branch review)", () => {
  test("claude-code is always kept even when presence.claude is false", () => {
    const { kept, dropped } = filterPresetByPresence(["claude-code"], bare);
    expect(kept).toEqual(["claude-code"]);
    expect(dropped).toEqual([]);
  });

  test("named-but-absent secondary host (qodercli) is dropped, not wired", () => {
    const { kept, dropped } = filterPresetByPresence(["claude-code", "qodercli"], bare);
    expect(kept).toEqual(["claude-code"]);
    expect(dropped).toEqual(["qodercli"]);
  });

  test("present secondary host survives the filter", () => {
    const p = { ...bare, qodercli: true };
    const { kept, dropped } = filterPresetByPresence(["claude-code", "qodercli"], p);
    expect(kept).toEqual(["claude-code", "qodercli"]);
    expect(dropped).toEqual([]);
  });

  test("mixed set: absent codex + codebuddy dropped, present antigravity kept", () => {
    const p = { ...bare, antigravity: true };
    const { kept, dropped } = filterPresetByPresence(
      ["claude-code", "codex", "codebuddy", "antigravity"],
      p,
    );
    expect(kept).toEqual(["claude-code", "antigravity"]);
    expect(dropped).toEqual(["codex", "codebuddy"]);
  });
});
