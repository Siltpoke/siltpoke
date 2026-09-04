import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/cli/install";
import type { Exec } from "../../src/installer/prereq";

function fakeIO(answers: string[] = []) {
  let i = 0;
  const out: string[] = [];
  return { io: { readLine: async () => answers[i++] ?? "n", write: (s: string) => out.push(s) }, out };
}

describe("runInstall presetAgents (AC10)", () => {
  test("preset provided → no 'Which CLI agents?' prompt, wires exactly the preset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-preset-"));
    const { io, out } = fakeIO([]);
    const res = await runInstall({
      io,
      noninteractive: false,
      presetAgents: ["claude-code"],
      env: { ...process.env, CLAUDE_HOME: dir, SILTPOKE_HOME: join(dir, ".siltpoke") },
      platform: "darwin",
    });
    // the interactive agent multi-choice must NOT have been shown
    expect(out.join("")).not.toContain("Which CLI agents");
    expect(res.status).not.toBe("internal_subprocess");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runInstall --agent flag (Fix 1, final-branch review)", () => {
  test("agentFlagUsed:true + presetAgents:['qodercli'] on a machine WITHOUT qoder → does NOT wire ~/.qoder, emits skip note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-agent-flag-"));
    const claudeHome = join(dir, ".claude");
    const qoderHome = join(dir, ".qoder");
    // Fake settings.json so runInstall doesn't hit the no_settings early-return.
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({}));

    // exec reports every CLI absent (status !== 0) — including qodercli.
    const absentExec: Exec = () => ({ status: 1, stdout: "" });

    const { io, out } = fakeIO([]);
    const res = await runInstall({
      io,
      noninteractive: true,
      presetAgents: ["qodercli"],
      agentFlagUsed: true,
      exec: absentExec,
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_HOME: claudeHome,
        QODER_HOME: qoderHome,
        SILTPOKE_HOME: join(dir, ".siltpoke"),
        CI: "true",
      },
      platform: "darwin",
    });

    expect(res.status).not.toBe("internal_subprocess");
    // The absent secondary host must NOT be wired — no ~/.qoder/settings.json write.
    expect(existsSync(join(qoderHome, "settings.json"))).toBe(false);
    expect(out.join("")).toContain(
      "⚠ Qoder not detected on PATH — skipped (siltpoke wires, never installs the CLI)",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("agentFlagUsed:true + presetAgents:['qodercli'] on a machine WITH qoder present → wires it, no skip note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-agent-flag-present-"));
    const claudeHome = join(dir, ".claude");
    const qoderHome = join(dir, ".qoder");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({}));

    // exec reports qodercli present, everything else absent.
    const presentQoderExec: Exec = (_cmd, args) => {
      const target = args[args.length - 1];
      return { status: target === "qodercli" ? 0 : 1, stdout: "" };
    };

    const repoRoot = join(dir, "repo");
    mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
    writeFileSync(join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"), "---\ndescription: fake\n---\nbody");

    const { io, out } = fakeIO([]);
    const res = await runInstall({
      io,
      noninteractive: true,
      presetAgents: ["qodercli"],
      agentFlagUsed: true,
      exec: presentQoderExec,
      repoRoot,
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_HOME: claudeHome,
        QODER_HOME: qoderHome,
        SILTPOKE_HOME: join(dir, ".siltpoke"),
        CI: "true",
      },
      platform: "darwin",
    });

    expect(res.status).not.toBe("internal_subprocess");
    expect(existsSync(join(qoderHome, "settings.json"))).toBe(true);
    expect(out.join("")).not.toContain("not detected on PATH");
    rmSync(dir, { recursive: true, force: true });
  });
});
