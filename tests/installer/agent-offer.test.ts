import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaude, installCodex } from "../../src/installer/agent-offer";
import type { Exec } from "../../src/installer/prereq";

// The installers record into the install receipt ([61] P1.3): sandbox home, never the real one.
const env = { HOME: mkdtempSync(join(tmpdir(), "siltpoke-agent-offer-")) };

describe("installClaude helper", () => {
  test("success → true, runs install.sh", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "" }; };
    const out: string[] = [];
    const ok = installClaude(exec, { readLine: async () => "", write: (s) => out.push(s) }, env);
    expect(ok).toBe(true);
    expect(calls.some((c) => c.args.join(" ").includes("claude.ai/install.sh"))).toBe(true);
  });
  test("failure → false + warns", () => {
    const exec: Exec = () => ({ status: 1, stdout: "" });
    const out: string[] = [];
    const ok = installClaude(exec, { readLine: async () => "", write: (s) => out.push(s) }, env);
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
