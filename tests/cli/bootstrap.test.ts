// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BootstrapOpts, defaultPlcExec, runBootstrap } from "../../src/cli/bootstrap";
import type { EditorPresence } from "../../src/installer/editor-detect";
import { t } from "../../src/installer/i18n";
import type { PlcExec } from "../../src/installer/plc-install";
import type { Exec } from "../../src/installer/prereq";
import type { WizardIO } from "../../src/installer/wizard";

/** Fake `command -v <bin>` responder — reports only `present` binaries as found. */
function makeExec(present: Set<string>): Exec {
  return (cmd: string, args: string[]) => {
    if (cmd === "command" && args[0] === "-v") {
      const bin = args[1] ?? "";
      return present.has(bin) ? { status: 0, stdout: `/usr/bin/${bin}` } : { status: 1, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
}

// Stub for the optional project-lifecycle plugin install step. Every test
// below that reaches "installed" would otherwise fall through to
// runBootstrap's REAL plcExec default, which shells out to a real `claude`
// binary via resolveAgentBinary + Bun.spawnSync — a genuine subprocess call
// that is absent (and, pre-fix, fatal) on a Linux CI runner with no `claude`
// on PATH. Inject a fully hermetic no-op instead.
const noopPlcExec: PlcExec = () => ({ status: 0, stdout: "", stderr: "" });

const exec = makeExec(new Set(["bun", "git", "brew", "node"]));
const io: WizardIO = { readLine: async () => "", write: () => {} };
let home: string, claudeHome: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "bs-")); claudeHome = join(home, ".claude"); mkdirSync(claudeHome, { recursive: true }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("runBootstrap", () => {
  test("--check mutates nothing", async () => {
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => { throw new Error("should not run"); };
    const r = await runBootstrap({ exec, io, claudeHome, check: true, runInstallFn });
    expect(r.status).toBe("planned");
    expect(r.plan.length).toBeGreaterThan(0);
  });

  test("--check with missing bun/git → plan lists install steps, mutates nothing", async () => {
    const missingExec = makeExec(new Set());
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => { throw new Error("should not run"); };
    const r = await runBootstrap({ exec: missingExec, io, claudeHome, check: true, platform: "darwin", runInstallFn });
    expect(r.status).toBe("planned");
    expect(r.plan).toContain("install bun (curl)");
    expect(r.plan).toContain("install git (Xcode Command Line Tools)");
  });

  test("unparseable settings.json → refused", async () => {
    writeFileSync(join(claudeHome, "settings.json"), "{ bad");
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => ({});
    const r = await runBootstrap({ exec, io, claudeHome, runInstallFn });
    expect(r.status).toBe("refused");
  });

  test("runInstall throws → rolled back, with error message captured", async () => {
    writeFileSync(join(claudeHome, "settings.json"), "{}");
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => { throw new Error("boom"); };
    const r = await runBootstrap({ exec, io, claudeHome, yes: true, runInstallFn });
    expect(r.status).toBe("rolled-back");
    expect(r.rolledBack).toContain("restore settings.json");
    expect(r.error).toBe("boom");
  });

  test("runInstall throws → settings.json restored to pre-install content", async () => {
    const original = '{"marker":"ORIGINAL"}';
    writeFileSync(join(claudeHome, "settings.json"), original);
    const runInstallFn = (async () => {
      // simulate runInstall having mutated settings.json before throwing
      writeFileSync(join(claudeHome, "settings.json"), '{"marker":"MUTATED"}');
      throw new Error("boom");
    }) as any;
    const r = await runBootstrap({ exec, io, claudeHome, yes: true, platform: "darwin", runInstallFn });
    expect(r.status).toBe("rolled-back");
    expect(r.rolledBack).toContain("restore settings.json");
    // the real proof: content is back to ORIGINAL, not MUTATED
    expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(original);
  });

  test("win32: --check plan uses winget wording", async () => {
    const winExec: Exec = (c, a) => ({ status: 1, stdout: "" }); // all prereqs absent on win
    const r = await runBootstrap({ exec: winExec, io, claudeHome, check: true, platform: "win32", runInstallFn: (async () => ({})) as any });
    expect(r.status).toBe("planned");
    expect(r.plan.join("\n")).toContain("git (winget)");
  });

  test("happy path → installed", async () => {
    writeFileSync(join(claudeHome, "settings.json"), "{}");
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => ({ ok: true });
    const r = await runBootstrap({ exec, io, claudeHome, yes: true, runInstallFn, plcExecFn: noopPlcExec });
    expect(r.status).toBe("installed");
  });

  test("yes:true auto-answers prereq prompts without reading real io", async () => {
    writeFileSync(join(claudeHome, "settings.json"), "{}");
    const missingExec = makeExec(new Set());
    const throwingIo: WizardIO = {
      readLine: async () => { throw new Error("should not prompt real io when yes:true"); },
      write: () => {},
    };
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => ({ ok: true });
    const r = await runBootstrap({
      exec: missingExec,
      io: throwingIo,
      claudeHome,
      yes: true,
      runInstallFn,
      plcExecFn: noopPlcExec,
    });
    expect(r.status).toBe("installed");
  });

  test("PLC plugin step: missing `claude` binary degrades to a warning instead of rolling back the whole install", async () => {
    // Reproduces the exact Linux-CI failure mode: Bun.spawnSync throws
    // synchronously ("Executable not found in $PATH") when the binary can't
    // be resolved at all — not a non-zero exit, an actual throw. Before the
    // fix this escaped installPlc's "non-fatal" contract and rolled back
    // runBootstrap's entire (otherwise successful) install.
    writeFileSync(join(claudeHome, "settings.json"), "{}");
    const runInstallFn: BootstrapOpts["runInstallFn"] = async () => ({ ok: true });
    const throwingPlcExec: PlcExec = () => {
      throw new Error("Executable not found in $PATH: \"claude\"");
    };
    const r = await runBootstrap({
      exec,
      io,
      claudeHome,
      yes: true,
      runInstallFn,
      plcExecFn: throwingPlcExec,
    });
    expect(r.status).toBe("installed");
  });
});

// The default (non-injected) plcExec — every runBootstrap test above injects
// plcExecFn, so the REAL production inner try/catch (the actual Linux code
// path: Bun.spawnSync throws synchronously when the binary can't be
// resolved at all, rather than returning a non-zero exit) was previously
// only reachable through runBootstrap's OUTER safety net, never exercised
// directly. Test the exported default itself.
describe("defaultPlcExec (real, non-injected)", () => {
  test("binary that cannot resolve at all → inner catch, does not throw", () => {
    const r = defaultPlcExec("definitely-not-a-real-binary-xyz-siltpoke", ["--version"]);
    expect(r.status).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("resolvable binary → real spawn succeeds, status 0", () => {
    const r = defaultPlcExec("echo", ["hi"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });
});

describe("runBootstrap localized surface steps", () => {
  test("--yes prints the OS/arch line and a localized closing message", async () => {
    const out: string[] = [];
    const present = ["claude", "bun", "git"];
    const localExec: Exec = (_cmd, args) => ({
      status: present.includes(args[args.length - 1]) ? 0 : 1,
      stdout: "",
    });
    const localIo: WizardIO = { write: (s: string) => { out.push(s); }, readLine: async () => "y" };
    writeFileSync(join(claudeHome, "settings.json"), "{}");
    await runBootstrap({
      exec: localExec,
      io: localIo,
      claudeHome,
      yes: true,
      platform: "darwin",
      arch: "arm64",
      runInstallFn: async () => {},
      plcExecFn: noopPlcExec,
    });
    const text = out.join("");
    expect(text).toContain("macOS · Apple Silicon (arm64)");
    expect(text).toContain("siltpoke"); // closing line present
  });
});

const edPlugin: EditorPresence = { vscode: true, cursor: false, claudeExtInVscode: true, claudeExtInCursor: false };
const edNoPlugin: EditorPresence = { vscode: true, cursor: false, claudeExtInVscode: false, claudeExtInCursor: false };
const edBare: EditorPresence = { vscode: false, cursor: false, claudeExtInVscode: false, claudeExtInCursor: false };

// Minimal exec that satisfies preflight + reports claude present so we reach the close.
function bootExec(): Exec { return (_cmd, _args) => ({ status: 0, stdout: "" }); }

test("Branch B: editor detected, no plugin, ask-yes → opens the deep-link", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "" }; };
  const out: string[] = [];
  writeFileSync(join(claudeHome, "settings.json"), "{}");
  await runBootstrap({
    exec,
    io: { readLine: async () => "y", write: (s) => out.push(s) },
    claudeHome, // hermetic temp dir, not the real machine's ~/.claude
    yes: true,               // auto-yes so the flow runs unattended
    platform: "darwin",
    detectEditorsFn: () => edNoPlugin,
    runInstallFn: async () => ({}),
    plcExecFn: noopPlcExec,
  });
  expect(calls.some((c) => c.args.join(" ").includes("extension/anthropic.claude-code"))).toBe(true);
});

test("Branch A: plugin present → editor-framed copy, NO deep-link open", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "" }; };
  writeFileSync(join(claudeHome, "settings.json"), "{}");
  await runBootstrap({
    exec,
    io: { readLine: async () => "y", write: () => {} },
    claudeHome, // hermetic temp dir, not the real machine's ~/.claude
    yes: true,
    platform: "darwin",
    detectEditorsFn: () => edPlugin,
    runInstallFn: async () => ({}),
    plcExecFn: noopPlcExec,
  });
  expect(calls.some((c) => c.args.join(" ").includes("extension/anthropic.claude-code"))).toBe(false);
});

test("Branch C: no editor detected → writes done.terminalC, NOT done.editor", async () => {
  const out: string[] = [];
  const terminalCMsg = t("done.terminalC", "en");
  const editorMsg = t("done.editor", "en");

  let answerIndex = 0;
  const customIo: WizardIO = {
    readLine: async () => {
      const answers = ["en", "n"]; // locale → "en", editor question → "n" (no editor)
      return answers[answerIndex++] ?? "";
    },
    write: (s) => out.push(s),
  };

  writeFileSync(join(claudeHome, "settings.json"), "{}");
  await runBootstrap({
    exec: bootExec(),
    io: customIo,
    claudeHome, // hermetic temp dir, not the real machine's ~/.claude
    platform: "darwin",
    detectEditorsFn: () => edBare,
    runInstallFn: async () => ({}),
    plcExecFn: noopPlcExec,
  });

  const text = out.join("");
  expect(text).toContain(terminalCMsg);
  expect(text).not.toContain(editorMsg);
});
