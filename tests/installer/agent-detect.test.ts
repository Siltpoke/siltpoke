import { describe, test, expect } from "bun:test";
import { detectAgents, reportAgents } from "../../src/installer/agent-detect";
import type { Exec } from "../../src/installer/prereq";

// spy exec: status 0 for bins in `present`, 1 otherwise; records calls
function spyExec(present: string[]) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    const bin = args[args.length - 1];
    return { status: present.includes(bin) ? 0 : 1, stdout: "" };
  };
  return { calls, exec };
}

describe("detectAgents", () => {
  test("command -v per agent (POSIX); Antigravity CLI + via existsSync (AC9)", () => {
    const { calls, exec } = spyExec(["claude", "codex"]);
    const p = detectAgents({
      exec,
      existsSync: (path) => path === "/Applications/Antigravity.app",
      platform: "darwin",
    });
    expect(p).toEqual({
      claude: true, codex: true, codebuddy: false, qodercli: false, antigravity: false, antigravityApp: true,
    });
    // command -v used (POSIX), one probe per CLI agent including antigravity
    expect(calls.every((c) => c.cmd === "command" && c.args[0] === "-v")).toBe(true);
    expect(calls.map((c) => c.args[1])).toEqual(["claude", "codex", "codebuddy", "qodercli", "agy"]);
  });

  test("antigravity CLI is probed by its real binary name `agy` (not `antigravity`)", () => {
    const { calls, exec } = spyExec([]);
    detectAgents({ exec, existsSync: () => false, platform: "darwin" });
    expect(calls.some((c) => c.args[c.args.length - 1] === "agy")).toBe(true);
    expect(calls.some((c) => c.args[c.args.length - 1] === "antigravity")).toBe(false);
  });

  test("win32 uses where", () => {
    const { calls, exec } = spyExec([]);
    detectAgents({ exec, existsSync: () => false, platform: "win32" });
    expect(calls.every((c) => c.cmd === "where")).toBe(true);
  });

  test("probes the antigravity CLI (command -v agy)", () => {
    const { calls, exec } = spyExec(["agy"]);
    const p = detectAgents({ exec, existsSync: () => false, platform: "darwin" });
    expect(p.antigravity).toBe(true);
    expect(calls.some((c) => c.args[c.args.length - 1] === "agy")).toBe(true);
  });
});

describe("reportAgents", () => {
  test("plain-language: codebuddy/qoder report wired vs not-detected", () => {
    const wired = reportAgents({
      claude: true, codex: false, codebuddy: true, qodercli: true,
      antigravity: false, antigravityApp: false,
    });
    expect(wired).toContain("CodeBuddy detected");
    expect(wired).toContain("Qoder detected");
    expect(wired.toLowerCase()).not.toContain("integration coming");
  });
});
