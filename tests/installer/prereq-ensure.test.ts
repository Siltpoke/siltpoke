// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, ensureBun, ensureGit } from "../../src/installer/prereq";

// ensureBun/ensureGit write the install receipt; keep it in a sandbox.
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-prereq-ensure-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const io = (answer: boolean) => ({
  readLine: async () => (answer ? "y" : "n"),
  write: () => {},
});

describe("ensureBun", () => {
  test("present → no install", async () => {
    const calls: string[][] = [];
    const exec = (_c: string, a: string[]) => { calls.push(a); return { status: a.includes("bun") ? 0 : 1, stdout: "/x/bun" }; };
    const r = await ensureBun(exec, io(true), undefined, env);
    expect(r.action).toBe("present");
    expect(calls.some((a) => a.join(" ").includes("bun.com/install"))).toBe(false);
  });

  test("absent + consent → runs bun installer", async () => {
    const cmds: string[] = [];
    const exec = (c: string, a: string[]) => {
      if (a[0] === "-v") return { status: 1, stdout: "" }; // command -v bun → absent
      cmds.push([c, ...a].join(" "));
      return { status: 0, stdout: "" };
    };
    const r = await ensureBun(exec, io(true), undefined, env);
    expect(r.action).toBe("installed");
    expect(cmds.some((s) => s.includes("bun.com/install"))).toBe(true);
  });

  test("absent + decline → declined, no install", async () => {
    const exec = (_c: string, _a: string[]) => ({ status: 1, stdout: "" });
    const r = await ensureBun(exec, io(false), undefined, env);
    expect(r.action).toBe("declined");
  });
});

describe("ensureGit", () => {
  test("absent + consent → xcode-select --install, gui-pending", async () => {
    const cmds: string[] = [];
    const exec = (c: string, a: string[]) => {
      if (a[0] === "-v") return { status: 1, stdout: "" };
      cmds.push([c, ...a].join(" "));
      return { status: 0, stdout: "" };
    };
    const r = await ensureGit(exec, io(true), undefined, env);
    expect(r.action).toBe("gui-pending");
    expect(cmds.some((s) => s.includes("xcode-select") && s.includes("--install"))).toBe(true);
  });

  test("darwin prompt mentions Apple developer tools", async () => {
    const writes: string[] = [];
    const ioObj = { readLine: async () => "y", write: (s: string) => writes.push(s) };
    const exec: Exec = (_c, a) => {
      if (a[0] === "-v") return { status: 1, stdout: "" }; // git absent
      return { status: 0, stdout: "" };
    };
    await ensureGit(exec, ioObj, "darwin", env);
    expect(writes.join("")).toContain("Install Apple developer tools now?");
  });
});

describe("win32 provisioning", () => {
  test("Bun absent + consent → powershell irm installer, installed", async () => {
    const cmds: string[] = [];
    const exec: Exec = (c, a) => {
      const joined = [c, ...a].join(" ");
      if (c === "where") return { status: 1, stdout: "" }; // bun absent
      cmds.push(joined);
      return { status: 0, stdout: "" };
    };
    const r = await ensureBun(exec, io(true), "win32", env);
    expect(r.action).toBe("installed");
    expect(cmds.some((s) => s.includes("powershell") && s.includes("bun.sh/install.ps1"))).toBe(true);
  });

  test("git absent + consent + winget present → winget install, installed", async () => {
    const cmds: string[] = [];
    const exec: Exec = (c, a) => {
      if (c === "where" && a[0] === "git") return { status: 1, stdout: "" };   // git absent
      if (c === "where" && a[0] === "winget") return { status: 0, stdout: "" }; // winget present
      cmds.push([c, ...a].join(" "));
      return { status: 0, stdout: "" };
    };
    const r = await ensureGit(exec, io(true), "win32", env);
    expect(r.action).toBe("installed");
    expect(cmds.some((s) => s.includes("winget") && s.includes("Git.Git"))).toBe(true);
  });

  test("git absent + consent + NO winget → guide, no install", async () => {
    const writes: string[] = [];
    const ioObj = { readLine: async () => "y", write: (s: string) => writes.push(s) };
    const exec: Exec = (c, a) => {
      if (c === "where") return { status: 1, stdout: "" }; // git AND winget absent
      return { status: 0, stdout: "" };
    };
    const r = await ensureGit(exec, ioObj, "win32", env);
    expect(r.action).toBe("guide");
    expect(writes.join("")).toContain("gitforwindows.org");
  });
});
