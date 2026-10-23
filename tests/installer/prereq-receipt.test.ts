// [61] PR 2, plan P1.3 (spec §2.3): ensureBun / ensureGit record what they
// saw and did in the install receipt. byUs is observed at the moment of the
// check (`command -v` / `where`), the entry is pending before the installer
// runs and done only after it exits 0. Nothing touched ⇒ nothing recorded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, ensureBun, ensureGit } from "../../src/installer/prereq";
import { readReceipt } from "../../src/installer/receipt";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-prereq-receipt-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const yes = { readLine: async () => "y", write: () => {} };
const no = { readLine: async () => "n", write: () => {} };

/** `present` decides every `command -v` / `where` probe; installers exit with `installerStatus`. */
function fakeExec(present: Record<string, boolean>, installerStatus = 0): Exec {
  return (c, a) => {
    if (c === "command" && a[0] === "-v") return { status: present[a[1] as string] ? 0 : 1, stdout: "" };
    if (c === "where") return { status: present[a[0] as string] ? 0 : 1, stdout: "" };
    return { status: installerStatus, stdout: "" };
  };
}

function entry(id: string) {
  return readReceipt(env)?.entries.find((e) => e.id === id);
}

describe("ensureBun → receipt", () => {
  test("already present → recorded as not ours, done, nothing installed", async () => {
    await ensureBun(fakeExec({ bun: true }), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ kind: "outside-tool", target: "bun", byUs: false, state: "done", level: "purge" });
  });

  test("absent + yes + installer exits 0 → ours, done", async () => {
    await ensureBun(fakeExec({ bun: false }), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: true, state: "done" });
  });

  test("absent + yes + installer fails → ours, still pending (planner checks the disk)", async () => {
    await ensureBun(fakeExec({ bun: false }, 1), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: true, state: "pending" });
  });

  test("Windows installer path records the same way", async () => {
    await ensureBun(fakeExec({ bun: false }), yes, "win32", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: true, state: "done" });
  });

  test("declined → nothing recorded", async () => {
    await ensureBun(fakeExec({ bun: false }), no, "darwin", env);
    expect(readReceipt(env)).toBeNull();
  });

  test("declined → says how to install it later ([63]: a No / no-terminal skip names the command)", async () => {
    const out: string[] = [];
    await ensureBun(fakeExec({ bun: false }), { readLine: async () => "n", write: (s) => void out.push(s) }, "darwin", env);
    expect(out.join("")).toContain("https://bun.com/install");
    const outWin: string[] = [];
    await ensureBun(fakeExec({ bun: false }), { readLine: async () => "n", write: (s) => void outWin.push(s) }, "win32", env);
    expect(outWin.join("")).toContain("bun.sh/install.ps1");
  });
});

describe("ensureGit → receipt", () => {
  test("already present → not ours, done", async () => {
    await ensureGit(fakeExec({ git: true }), yes, "darwin", env);
    expect(entry("tool:git")).toMatchObject({ kind: "outside-tool", byUs: false, state: "done" });
  });

  test("macOS: xcode-select only opens a GUI installer → ours, left pending", async () => {
    await ensureGit(fakeExec({ git: false }), yes, "darwin", env);
    expect(entry("tool:git")).toMatchObject({ byUs: true, state: "pending" });
  });

  test("Windows + winget exits 0 → ours, done", async () => {
    await ensureGit(fakeExec({ git: false, winget: true }), yes, "win32", env);
    expect(entry("tool:git")).toMatchObject({ byUs: true, state: "done" });
  });

  test("Windows + winget fails → ours, still pending", async () => {
    await ensureGit(fakeExec({ git: false, winget: true }, 1), yes, "win32", env);
    expect(entry("tool:git")).toMatchObject({ byUs: true, state: "pending" });
  });

  test("Windows without winget → only a guide was printed, nothing recorded", async () => {
    await ensureGit(fakeExec({ git: false, winget: false }), yes, "win32", env);
    expect(readReceipt(env)).toBeNull();
  });

  test("declined → nothing recorded", async () => {
    await ensureGit(fakeExec({ git: false }), no, "darwin", env);
    expect(readReceipt(env)).toBeNull();
  });

  test("declined → says how to install it later", async () => {
    const out: string[] = [];
    await ensureGit(fakeExec({ git: false }), { readLine: async () => "n", write: (s) => void out.push(s) }, "darwin", env);
    expect(out.join("")).toContain("xcode-select --install");
    const outWin: string[] = [];
    await ensureGit(fakeExec({ git: false }), { readLine: async () => "n", write: (s) => void outWin.push(s) }, "win32", env);
    expect(outWin.join("")).toContain("winget install --id Git.Git");
  });
});

describe("re-runs (round 2: byUs freezes only once done)", () => {
  test("bun: a first run whose installer failed (pending, ours) then found present → recorded not ours", async () => {
    await ensureBun(fakeExec({ bun: false }, 1), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: true, state: "pending" });
    await ensureBun(fakeExec({ bun: true }), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: false, state: "done" });
  });

  test("bun: a DONE entry that is ours stays ours when a re-run finds it present", async () => {
    await ensureBun(fakeExec({ bun: false }), yes, "darwin", env);
    await ensureBun(fakeExec({ bun: true }), yes, "darwin", env);
    expect(entry("tool:bun")).toMatchObject({ byUs: true, state: "done" });
  });

  test("git: same rule", async () => {
    await ensureGit(fakeExec({ git: false }, 1), yes, "win32", env);
    await ensureGit(fakeExec({ git: true }), yes, "win32", env);
    expect(entry("tool:git")).toMatchObject({ byUs: false, state: "done" });
  });
});
