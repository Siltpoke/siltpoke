// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { runMenubarCli } from "../../src/cli/menubar";

function fakeIO() {
  return { readLine: async () => "", write: () => {} };
}

test("status reports not-installed when shim absent", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["status"], {
    home: "/Users/nobody",
    platform: "darwin",
    existsSync: () => false,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("not installed");
});

test("status reports installed when shim present", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p.endsWith("siltpoke.1m.sh"),
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("installed");
  expect(out.join("")).not.toContain("not installed");
});

test("unknown subcommand exits 1 with usage", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["frobnicate"], { write: (s) => out.push(s) });
  expect(code).toBe(1);
  expect(out.join("")).toContain("usage");
});

test("no subcommand exits 1 with usage", async () => {
  const out: string[] = [];
  const code = await runMenubarCli([], { write: (s) => out.push(s) });
  expect(code).toBe(1);
  expect(out.join("")).toContain("usage");
});

test("remove deletes the shim when present (consented)", async () => {
  const out: string[] = [];
  const removed: string[] = [];
  const code = await runMenubarCli(["remove"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p.endsWith("siltpoke.1m.sh"),
    write: (s) => out.push(s),
    rm: (p) => removed.push(p),
  });
  expect(code).toBe(0);
  expect(removed.some((p) => p.endsWith("siltpoke.1m.sh"))).toBe(true);
  expect(out.join("")).toContain("removed");
});

test("install: not-darwin prints a one-line notice and exits 0", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["install"], {
    platform: "linux",
    io: fakeIO(),
    write: (s) => out.push(s),
    runMenubarSetupFn: async () => ({
      installed: false,
      wroteShim: false,
      reason: "not-darwin",
    }),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("macOS-only");
});

test("install: delegates to runMenubarSetupFn and reports success", async () => {
  const out: string[] = [];
  const calls: unknown[] = [];
  const code = await runMenubarCli(["install"], {
    platform: "darwin",
    home: "/Users/t",
    io: fakeIO(),
    write: (s) => out.push(s),
    runMenubarSetupFn: async (deps) => {
      calls.push(deps);
      return { installed: true, wroteShim: true, reason: "ok" };
    },
  });
  expect(code).toBe(0);
  expect(calls.length).toBe(1);
  expect(out.join("")).toContain("installed");
});

test("install: threads nonInteractive + rendererPath through to setup", async () => {
  // The /siltpoke-menubar slash command has no TTY and (under a plugin
  // install) must point the shim at the bundled card — both must reach setup.
  const calls: Array<Record<string, unknown>> = [];
  const code = await runMenubarCli(["install"], {
    platform: "darwin",
    home: "/Users/t",
    io: fakeIO(),
    write: () => {},
    nonInteractive: true,
    rendererPath: "/plugin/dist/siltpoke-card.js",
    runMenubarSetupFn: async (deps) => {
      calls.push(deps as unknown as Record<string, unknown>);
      return { installed: true, wroteShim: true, reason: "ok" };
    },
  });
  expect(code).toBe(0);
  expect(calls[0]?.nonInteractive).toBe(true);
  expect(calls[0]?.rendererPath).toBe("/plugin/dist/siltpoke-card.js");
});

test("install: reports the reason when declined", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["install"], {
    platform: "darwin",
    home: "/Users/t",
    io: fakeIO(),
    write: (s) => out.push(s),
    runMenubarSetupFn: async () => ({
      installed: false,
      wroteShim: false,
      reason: "declined",
    }),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("declined");
});

test("remove is a no-op when shim absent", async () => {
  const out: string[] = [];
  const removed: string[] = [];
  const code = await runMenubarCli(["remove"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: () => false,
    write: (s) => out.push(s),
    rm: (p) => removed.push(p),
  });
  expect(code).toBe(0);
  expect(removed.length).toBe(0);
  expect(out.join("")).toContain("not installed");
});
