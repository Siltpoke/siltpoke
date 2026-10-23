// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [63] (plan P1.6, spec §2.4, §8 D-B): every install of something outside
// siltpoke — Claude Code, codex, the project-lifecycle plugin, the Ollama
// model — is asked ONCE before it is recorded or run; Ollama defaults to No;
// no terminal ⇒ skip and say how; `--yes` counts for the first three kinds,
// never for the model (`--with-local-model` does that); a No leaves nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap, wantsYes } from "../../src/cli/bootstrap";
import { runInstall } from "../../src/cli/install";
import type { AgentPresence } from "../../src/installer/agent-detect";
import { selectAndInstallAgents } from "../../src/installer/agent-menu";
import { askInstall } from "../../src/installer/consent";
import type { PlcExec } from "../../src/installer/plc-install";
import type { Exec } from "../../src/installer/prereq";
import { readReceipt } from "../../src/installer/receipt";
import { setupOllamaInteractive } from "../../src/installer/setup-ollama";
import type { WizardIO } from "../../src/installer/wizard";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-asks-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const noEditors = () => ({ vscode: false, cursor: false, claudeExtInVscode: false, claudeExtInCursor: false });
const bare: AgentPresence = { claude: false, codex: false, codebuddy: false, qodercli: false, antigravity: false, antigravityApp: false };
const ids = () => readReceipt(env)?.entries.map((e) => e.id) ?? [];

/** An io that answers from a script and records what it was asked. */
function scripted(answers: string[]): { io: WizardIO; out: () => string; questions: () => number } {
  let i = 0;
  const chunks: string[] = [];
  return {
    io: { readLine: async () => answers[i++] ?? "", write: (s) => void chunks.push(s) },
    out: () => chunks.join(""),
    questions: () => chunks.filter((c) => c.includes("? ")).length,
  };
}

/** Records every command the installers run. */
function recordingExec(): { exec: Exec; ran: string[] } {
  const ran: string[] = [];
  const exec: Exec = (cmd, args) => {
    ran.push([cmd, ...args].join(" "));
    return { status: 0, stdout: "" };
  };
  return { exec, ran };
}
const ranInstaller = (ran: string[], what: string) => ran.some((r) => r.includes(what));

describe("askInstall", () => {
  test("a No says how to do it later; nothing else", async () => {
    const s = scripted(["n"]);
    expect(await askInstall(s.io, "Install X?", "do-x --now")).toBe(false);
    expect(s.out()).toContain("do-x --now");
  });

  test("no terminal and no --yes: not even asked, skipped with the command", async () => {
    const s = scripted(["y"]);
    expect(await askInstall(s.io, "Install X?", "do-x --now", { interactive: false })).toBe(false);
    expect(s.questions()).toBe(0);
    expect(s.out()).toContain("do-x --now");
  });

  test("no terminal but --yes: goes ahead (the caller's io answers y)", async () => {
    const s = scripted(["y"]);
    expect(await askInstall(s.io, "Install X?", "do-x", { interactive: false, yes: true })).toBe(true);
  });

  test("Enter takes the default: yes unless told otherwise", async () => {
    expect(await askInstall(scripted([""]).io, "Install X?", "x")).toBe(true);
    expect(await askInstall(scripted([""]).io, "Install X?", "x", { default: "no" })).toBe(false);
  });
});

describe("Claude Code (selected + absent)", () => {
  const pick = (answers: string[] = ["1"]) => scripted(answers);

  test("asked once; yes → installed and recorded", async () => {
    const { exec, ran } = recordingExec();
    const s = pick(["1", "y"]);
    const r = await selectAndInstallAgents({ presence: bare, io: s.io, exec, platform: "darwin", locale: "en", env });
    expect(r.exit).toBe(false);
    expect(ranInstaller(ran, "claude.ai/install.sh")).toBe(true);
    expect(ids()).toContain("tool:claude-code");
    expect(s.out().match(/Claude Code is not installed/g)?.length).toBe(1);
  });

  test("No → the installer never runs, nothing is recorded, the exit says how", async () => {
    const { exec, ran } = recordingExec();
    const s = pick(["1", "n"]);
    const r = await selectAndInstallAgents({ presence: bare, io: s.io, exec, platform: "darwin", locale: "en", env });
    expect(r.exit).toBe(true);
    expect(ranInstaller(ran, "claude.ai/install.sh")).toBe(false);
    expect(ids()).not.toContain("tool:claude-code");
    expect(s.out()).toContain("claude.ai/install.sh");
  });

  test("no terminal, no --yes → skipped without a question", async () => {
    const { exec, ran } = recordingExec();
    const s = pick(["1"]);
    const r = await selectAndInstallAgents({ presence: bare, io: s.io, exec, platform: "darwin", locale: "en", env, consent: { interactive: false } });
    expect(r.exit).toBe(true);
    expect(ranInstaller(ran, "claude.ai/install.sh")).toBe(false);
    expect(ids()).not.toContain("tool:claude-code");
  });

  test("no terminal but --yes → installed", async () => {
    const { exec, ran } = recordingExec();
    const s = pick(["1", "y"]);
    await selectAndInstallAgents({ presence: bare, io: s.io, exec, platform: "darwin", locale: "en", env, consent: { interactive: false, yes: true } });
    expect(ranInstaller(ran, "claude.ai/install.sh")).toBe(true);
  });

  test("not selected and absent: the host question also goes through the no-terminal rule", async () => {
    const { exec, ran } = recordingExec();
    const p = { ...bare, codex: true };
    const s = scripted(["2"]); // codex only
    const r = await selectAndInstallAgents({ presence: p, io: s.io, exec, platform: "darwin", locale: "en", env, consent: { interactive: false } });
    expect(r.exit).toBe(true);
    expect(ranInstaller(ran, "claude.ai/install.sh")).toBe(false);
  });
});

describe("codex (selected + absent)", () => {
  const withClaude = { ...bare, claude: true };

  test("asked once; yes → npm install runs and is recorded", async () => {
    const { exec, ran } = recordingExec();
    const s = scripted(["1,2", "y"]);
    const r = await selectAndInstallAgents({ presence: withClaude, io: s.io, exec, platform: "darwin", locale: "en", env });
    expect(ranInstaller(ran, "npm install -g @openai/codex")).toBe(true);
    expect(r.presetAgents).toContain("codex");
    expect(ids()).toContain("tool:codex");
    expect(s.out().match(/Codex is not installed/g)?.length).toBe(1);
  });

  test("No → no npm install, codex dropped, nothing recorded, says how", async () => {
    const { exec, ran } = recordingExec();
    const s = scripted(["1,2", "n"]);
    const r = await selectAndInstallAgents({ presence: withClaude, io: s.io, exec, platform: "darwin", locale: "en", env });
    expect(ranInstaller(ran, "npm install -g @openai/codex")).toBe(false);
    expect(r.presetAgents).not.toContain("codex");
    expect(ids()).not.toContain("tool:codex");
    expect(s.out()).toContain("npm install -g @openai/codex");
  });

  test("no terminal, no --yes → skipped", async () => {
    const { exec, ran } = recordingExec();
    const s = scripted(["1,2"]);
    const r = await selectAndInstallAgents({ presence: withClaude, io: s.io, exec, platform: "darwin", locale: "en", env, consent: { interactive: false } });
    expect(ranInstaller(ran, "npm install -g @openai/codex")).toBe(false);
    expect(r.presetAgents).not.toContain("codex");
  });
});

describe("project-lifecycle plugin (bootstrap)", () => {
  // claude/bun/git all present so nothing else asks.
  const present: Exec = (cmd, args) =>
    cmd === "command" || cmd === "where"
      ? { status: ["bun", "git", "claude"].includes(args[args.length - 1] as string) ? 0 : 1, stdout: "" }
      : { status: 0, stdout: "" };
  const plcRan: string[][] = [];
  const plcExec: PlcExec = (_c, args) => {
    plcRan.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  const install = (a: string[]) => a[0] === "plugin" && a[1] === "install";

  const run = (extra: Partial<Parameters<typeof runBootstrap>[0]>, answers: string[]) => {
    plcRan.length = 0;
    const s = scripted(answers);
    const done = runBootstrap({
      exec: present,
      io: s.io,
      claudeHome: join(home, ".claude"),
      env,
      platform: "darwin",
      runInstallFn: async () => {},
      plcExecFn: plcExec,
      detectEditorsFn: noEditors,
      ...extra,
    });
    return { s, done };
  };
  // locale, editor-question, agent pick (claude is present: default selection), then PLC.
  const upToPlc = ["", "", ""];

  test("asked once; yes → installed", async () => {
    const { s, done } = run({}, [...upToPlc, "y"]);
    await done;
    expect(plcRan.some(install)).toBe(true);
    expect(s.out().match(/project-lifecycle plugin/gi)?.length).toBeGreaterThanOrEqual(1);
    expect(s.out().match(/Install the project-lifecycle plugin/g)?.length).toBe(1);
  });

  test("No → no claude plugin call at all, nothing recorded, says how", async () => {
    const { s, done } = run({}, [...upToPlc, "n"]);
    await done;
    expect(plcRan.filter((a) => a[1] !== "list")).toEqual([]); // only the read-only probe may run
    expect(ids()).not.toContain("tool:plc");
    expect(s.out()).toContain("claude plugin marketplace add Siltpoke/project-life-cycle");
  });

  /** An exec whose `claude plugin list` answers (status, stdout) and which records every call. */
  const listing = (listStatus: number, listOut: string): PlcExec => (_c, args) => {
    plcRan.push(args);
    return args[1] === "list" ? { status: listStatus, stdout: listOut, stderr: "" } : { status: 0, stdout: "", stderr: "" };
  };

  test("already installed → no question, NO install commands, recorded as not ours (review M2 + round 2)", async () => {
    const { s, done } = run({ plcExecFn: listing(0, "project-lifecycle@project-life-cycle enabled") }, upToPlc);
    await done;
    expect(s.out()).not.toContain("Install the project-lifecycle plugin");
    expect(plcRan.filter((a) => a[1] !== "list")).toEqual([]); // no marketplace add, no install
    expect(readReceipt(env)?.entries.find((e) => e.id === "tool:plc")).toMatchObject({ byUs: false, state: "done" });
  });

  test("the probe itself fails + no terminal + no --yes → NOT installed, said how (round 2)", async () => {
    const { s, done } = run({ plcExecFn: listing(1, ""), interactive: false }, upToPlc);
    await done;
    expect(plcRan.filter((a) => a[1] !== "list")).toEqual([]);
    expect(ids()).not.toContain("tool:plc");
    expect(s.out()).toContain("claude plugin marketplace add Siltpoke/project-life-cycle");
  });

  test("the probe itself fails + a terminal → the question IS asked; a No installs nothing", async () => {
    const { s, done } = run({ plcExecFn: listing(1, "") }, [...upToPlc, "n"]);
    await done;
    expect(s.out().match(/Install the project-lifecycle plugin/g)?.length).toBe(1);
    expect(plcRan.filter((a) => a[1] !== "list")).toEqual([]);
  });

  test("the probe fails, the user says yes, the install works → installed, recorded NOT ours (cannot show we did it)", async () => {
    const { done } = run({ plcExecFn: listing(1, "") }, [...upToPlc, "y"]);
    await done;
    expect(plcRan.some(install)).toBe(true);
    expect(readReceipt(env)?.entries.find((e) => e.id === "tool:plc")).toMatchObject({ byUs: false, state: "done" });
  });

  test("absent + yes → installed, recorded as ours, the probe ran once", async () => {
    const { done } = run({ plcExecFn: listing(0, "other-plugin") }, [...upToPlc, "y"]);
    await done;
    expect(plcRan.some(install)).toBe(true);
    expect(plcRan.filter((a) => a[1] === "list").length).toBe(1);
    expect(readReceipt(env)?.entries.find((e) => e.id === "tool:plc")).toMatchObject({ byUs: true, state: "done" });
  });

  test("no terminal, no --yes → skipped", async () => {
    const { done } = run({ interactive: false }, upToPlc);
    await done;
    expect(plcRan.filter((a) => a[1] !== "list")).toEqual([]); // only the read-only probe may run
  });

  test("--yes → installed without a question", async () => {
    // The real io must never be read: --yes answers for the user.
    const reads: number[] = [];
    const out: string[] = [];
    plcRan.length = 0;
    await runBootstrap({
      exec: present,
      io: {
        readLine: async () => {
          reads.push(1);
          return "";
        },
        write: (x) => void out.push(x),
      },
      claudeHome: join(home, ".claude"),
      env,
      platform: "darwin",
      runInstallFn: async () => {},
      plcExecFn: plcExec,
      detectEditorsFn: noEditors,
      yes: true,
      interactive: false,
    });
    expect(plcRan.some(install)).toBe(true);
    expect(reads).toEqual([]);
  });
});

describe("the local model (spec §8 D-B)", () => {
  const deps = { checkInstalled: async () => true, hasModel: async () => false, validate: async () => true };

  test("setupOllamaInteractive: consent No → no pull, nothing recorded, no 'pulling' notice", async () => {
    let pulled = false;
    const s = scripted([]);
    const r = await setupOllamaInteractive({
      io: s.io,
      env,
      consent: async () => false,
      deps: { ...deps, pull: async () => {
          pulled = true;
        } },
    });
    expect(r.enabled).toBe(false);
    expect(pulled).toBe(false);
    expect(readReceipt(env)).toBeNull();
    expect(s.out().toLowerCase()).not.toContain("pulling");
  });

  test("setupOllamaInteractive: consent Yes → pulled and recorded", async () => {
    let pulled = false;
    await setupOllamaInteractive({ io: scripted([]).io, env, consent: async () => true, deps: { ...deps, pull: async () => {
          pulled = true;
        } } });
    expect(pulled).toBe(true);
    expect(ids()).toContain("tool:ollama-model");
  });

  test("consent is not asked when ollama itself is not installed", async () => {
    let asked = false;
    await setupOllamaInteractive({
      io: scripted([]).io,
      env,
      consent: async () => {
        asked = true;
        return true;
      },
      deps: { ...deps, checkInstalled: async () => false },
    });
    expect(asked).toBe(false);
  });

  /** Drive runInstall just far enough to hand its consent to the model step. */
  async function modelConsent(opts: { noninteractive: boolean; withLocalModel?: boolean; answers?: string[] }) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    const repoRoot = join(home, "repo");
    mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
    const s = scripted(opts.answers ?? []);
    let consent: (() => Promise<boolean>) | undefined;
    await runInstall({
      env,
      repoRoot,
      io: s.io,
      noninteractive: opts.noninteractive,
      withLocalModel: opts.withLocalModel,
      presetAgents: ["claude-code"],
      installAutostartFn: async () => ({ status: "skipped", platform: "test" }),
      // NEVER reach the real menu-bar setup: on a Mac with SwiftBar it rewrites the
      // real shim + login item and relaunches SwiftBar (this test once did, 2026-10-03).
      platform: "linux",
      runMenubarSetupFn: async () => {
        throw new Error("the menu-bar setup must not run in this test");
      },
      setupOllamaFn: async (o) => {
        consent = o.consent;
        return { enabled: false };
      },
    });
    return { consent, s };
  }

  test("interactive: asked once, default No (Enter pulls nothing), the size is in the question", async () => {
    const { consent, s } = await modelConsent({ noninteractive: false, answers: ["yes", "Mochi", "cat", "zh-CN", "1", "n", ""] });
    expect(consent).toBeDefined();
    const before = s.questions();
    expect(await consent?.()).toBe(false); // Enter → default No
    expect(s.questions()).toBe(before + 1);
    expect(s.out()).toMatch(/4\.7 GB/);
  });

  test("interactive: typing y says yes", async () => {
    const { consent } = await modelConsent({ noninteractive: false, answers: ["yes", "Mochi", "cat", "zh-CN", "1", "n", "y"] });
    expect(await consent?.()).toBe(true);
  });

  test("no terminal: skipped with the command, never asked", async () => {
    const { consent, s } = await modelConsent({ noninteractive: true });
    const before = s.questions();
    expect(await consent?.()).toBe(false);
    expect(s.questions()).toBe(before);
    expect(s.out()).toContain("ollama pull");
  });

  test("--with-local-model: yes without a question, even with no terminal", async () => {
    const { consent, s } = await modelConsent({ noninteractive: true, withLocalModel: true });
    const before = s.questions();
    expect(await consent?.()).toBe(true);
    expect(s.questions()).toBe(before);
  });

  test("bootstrap --yes does NOT consent to the model; --with-local-model does, nothing else does", async () => {
    const seen: Array<boolean | undefined> = [];
    const present: Exec = (cmd, args) =>
      cmd === "command" || cmd === "where"
        ? { status: ["bun", "git", "claude"].includes(args[args.length - 1] as string) ? 0 : 1, stdout: "" }
        : { status: 0, stdout: "" };
    const base = {
      exec: present,
      io: scripted([]).io,
      claudeHome: join(home, ".claude"),
      env,
      platform: "darwin" as const,
      plcExecFn: (() => ({ status: 0, stdout: "", stderr: "" })) as PlcExec,
      detectEditorsFn: noEditors,
      runInstallFn: async (_io: WizardIO, _a: unknown, extra?: { withLocalModel?: boolean }) => {
        seen.push(extra?.withLocalModel);
      },
    };
    await runBootstrap({ ...base, yes: true });
    await runBootstrap({ ...base, yes: true, withLocalModel: true });
    await runBootstrap({ ...base });
    expect(seen).toEqual([false, true, false]);
  });
});

describe("wantsYes (review M6): --yes, or SILTPOKE_YES=1 where no argument can be passed (irm | iex)", () => {
  test("flag", () => expect(wantsYes(["--yes"], {})).toBe(true));
  test("env", () => expect(wantsYes([], { SILTPOKE_YES: "1" })).toBe(true));
  test("neither, and a different env value", () => {
    expect(wantsYes([], {})).toBe(false);
    expect(wantsYes([], { SILTPOKE_YES: "0" })).toBe(false);
    expect(wantsYes(["--with-local-model"], { SILTPOKE_YES: "1" })).toBe(true); // env still counts next to other flags
  });
  test("--with-local-model alone is not --yes", () => expect(wantsYes(["--with-local-model"], {})).toBe(false));
});
