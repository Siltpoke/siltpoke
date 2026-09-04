import { describe, test, expect } from "bun:test";
import { installPlc, type PlcExec } from "../../src/installer/plc-install";

function fakeIO() {
  const out: string[] = [];
  return { io: { readLine: async () => "", write: (s: string) => out.push(s) }, out };
}
function spyExec(results: Array<{ status: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  let i = 0;
  const exec: PlcExec = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    const r = results[i++] ?? { status: 0 };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { calls, exec };
}

describe("installPlc", () => {
  test("no claude → no-claude, no exec (AC15 host requirement)", () => {
    const { io } = fakeIO();
    const { calls, exec } = spyExec([]);
    const r = installPlc({ exec, io: io, claudePresent: false });
    expect(r.reason).toBe("no-claude");
    expect(calls.length).toBe(0);
  });

  test("happy path: marketplace add then plugin install, suppression env set (AC15/AC17)", () => {
    const { io } = fakeIO();
    const { calls, exec } = spyExec([{ status: 0 }, { status: 0 }]);
    const r = installPlc({ exec, io, claudePresent: true });
    expect(r).toMatchObject({ added: true, installed: true, reason: "ok" });
    expect(calls[0].args.join(" ")).toContain("marketplace add Siltpoke/project-life-cycle");
    expect(calls[1].args.join(" ")).toContain("install project-lifecycle@project-life-cycle");
    // AC17: suppression env on every claude-plugin exec
    for (const c of calls) {
      expect(c.env?.SILTPOKE_SUPPRESSION_ENABLED).toBe("1");
      expect(c.env?.SILTPOKE_SUPPRESSION_DISABLE_RESPAWN).toBe("1");
    }
  });

  test("idempotent: 'already' stderr → reason already, still success", () => {
    const { io } = fakeIO();
    const { exec } = spyExec([
      { status: 1, stderr: "marketplace already added" },
      { status: 1, stderr: "plugin already installed" },
    ]);
    const r = installPlc({ exec, io, claudePresent: true });
    expect(r).toMatchObject({ installed: true, reason: "already" });
  });

  test("claudeBin: invokes the resolved absolute claude path, not the bare name", () => {
    const { io } = fakeIO();
    const { calls, exec } = spyExec([{ status: 0 }, { status: 0 }]);
    installPlc({ exec, io, claudePresent: true, claudeBin: "/Users/x/.local/bin/claude" });
    expect(calls[0].cmd).toBe("/Users/x/.local/bin/claude");
    expect(calls[1].cmd).toBe("/Users/x/.local/bin/claude");
  });

  test("claudeBin: defaults to bare 'claude' when no claudeBin given (back-compat)", () => {
    const { io } = fakeIO();
    const { calls, exec } = spyExec([{ status: 0 }, { status: 0 }]);
    installPlc({ exec, io, claudePresent: true });
    expect(calls[0].cmd).toBe("claude");
    expect(calls[1].cmd).toBe("claude");
  });
});
