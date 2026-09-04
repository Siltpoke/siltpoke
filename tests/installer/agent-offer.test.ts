import { describe, expect, test } from "bun:test";
import { installClaude, installCodex } from "../../src/installer/agent-offer";
import type { Exec } from "../../src/installer/prereq";

describe("installClaude helper", () => {
  test("success → true, runs install.sh", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "" }; };
    const out: string[] = [];
    const ok = installClaude(exec, { readLine: async () => "", write: (s) => out.push(s) });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.args.join(" ").includes("claude.ai/install.sh"))).toBe(true);
  });
  test("failure → false + warns", () => {
    const exec: Exec = () => ({ status: 1, stdout: "" });
    const out: string[] = [];
    const ok = installClaude(exec, { readLine: async () => "", write: (s) => out.push(s) });
    expect(ok).toBe(false);
    expect(out.join("")).toMatch(/did not succeed/i);
  });
});

describe("installCodex helper", () => {
  test("npm absent → false + guides", () => {
    const exec: Exec = (cmd) => (cmd === "node" || cmd === "command" ? { status: 1, stdout: "" } : { status: 0, stdout: "" });
    const out: string[] = [];
    const ok = installCodex(exec, { readLine: async () => "", write: (s) => out.push(s) }, "darwin");
    expect(ok).toBe(false);
    expect(out.join("")).toMatch(/node|npm/i);
  });
});
