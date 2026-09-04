// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect } from "bun:test";
import { detectPrereqs, type Exec } from "../../src/installer/prereq";

const fakeExec = (present: Record<string, boolean>): Exec => (_cmd, args) => {
  const bin = args[args.length - 1];
  return present[bin]
    ? { status: 0, stdout: `/usr/bin/${bin}\n` }
    : { status: 1, stdout: "" };
};

describe("detectPrereqs", () => {
  test("reports present when command -v exits 0", () => {
    const r = detectPrereqs(fakeExec({ bun: true, git: false }), ["bun", "git"]);
    expect(r.find((x) => x.name === "bun")?.present).toBe(true);
    expect(r.find((x) => x.name === "git")?.present).toBe(false);
  });

  test("defaults to all four prereqs", () => {
    const r = detectPrereqs(fakeExec({}));
    expect(r.map((x) => x.name).sort()).toEqual(["brew", "bun", "git", "node"]);
  });

  test("win32: probes via `where`, not `command -v`", () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      // pretend `where git` succeeds, `where bun` fails
      return { status: args[args.length - 1] === "git" ? 0 : 1, stdout: "" };
    };
    const r = detectPrereqs(exec, ["bun", "git"], "win32");
    expect(calls.every((c) => c[0] === "where")).toBe(true);
    expect(r.find((x) => x.name === "git")?.present).toBe(true);
    expect(r.find((x) => x.name === "bun")?.present).toBe(false);
  });
});
