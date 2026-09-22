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
    exec: execStub({ running: false }).exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("not installed");
});

test("status: no pref set → the default folder IS the obeyed folder", async () => {
  const out: string[] = [];
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) =>
      p === "/Users/somebody/Library/Application Support/SwiftBar/plugins/siltpoke.1m.sh",
    exec: execStub({ pref: null, running: true }).exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("installed, SwiftBar running");
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
    exec: execStub({}).exec,
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
    exec: execStub({}).exec,
    write: (s) => out.push(s),
    rm: (p) => removed.push(p),
  });
  expect(code).toBe(0);
  expect(removed.length).toBe(0);
  expect(out.join("")).toContain("not installed");
});

// ---------------------------------------------------------------------------
// `status` answers "is the pet actually showing", not "does a file exist".
//
// Found in real use 2026-09-21: the shim was installed, SwiftBar was not
// running, the menu bar was empty — and `status` said "installed". Both
// statements were true and the answer was useless, so the user has nothing to
// act on. Same family as the doctor row added for the Windows statusline:
// a check that never looks at the condition its own answer depends on.
//
// Three readers of the shim path (`status`, `remove`, and the notification
// gate in hooks/menubar-refresh.ts) each hardcoded the DEFAULT plugin folder,
// while `install` resolves SwiftBar's `PluginDirectory` pref and writes there.
// So for a user whose SwiftBar points anywhere else, install succeeded and all
// three readers reported nothing was installed.
// ---------------------------------------------------------------------------

function execStub(overrides: {
  pref?: string | null;
  running?: boolean;
}): { exec: (c: string, a: string[]) => { status: number; stdout: string }; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: (c, a) => {
      calls.push([c, ...a].join(" "));
      if (c === "defaults" && a[0] === "read") {
        return overrides.pref ? { status: 0, stdout: `${overrides.pref}\n` } : { status: 1, stdout: "" };
      }
      if (c === "pgrep") {
        return { status: overrides.running ? 0 : 1, stdout: overrides.running ? "123 SwiftBar\n" : "" };
      }
      return { status: 0, stdout: "" };
    },
  };
}

test("status: shim present and SwiftBar running → reports the pet is showing", async () => {
  const out: string[] = [];
  const { exec } = execStub({ running: true });
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p.endsWith("siltpoke.1m.sh"),
    exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  // The literal, not `toContain("installed")` — the PRE-fix implementation
  // printed "menu-bar pet: installed", which satisfied every loose form of
  // this assertion, so the test passed on a full revert of the fix.
  expect(out.join("")).toContain("installed, SwiftBar running");
});

test("status: shim present but SwiftBar NOT running → says so and how to start it", async () => {
  const out: string[] = [];
  const { exec } = execStub({ running: false });
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    // shim installed AND SwiftBar.app present — only the process is missing
    existsSync: (p) => p.endsWith("siltpoke.1m.sh") || p === "/Applications/SwiftBar.app",
    exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  const text = out.join("");
  expect(text).toContain("not running");
  expect(text).toContain("open -a SwiftBar");
});

test("status: shim present but SwiftBar.app missing → names the app, not the process", async () => {
  const out: string[] = [];
  const { exec } = execStub({ running: false });
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p.endsWith("siltpoke.1m.sh"),
    exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  const text = out.join("");
  expect(text).toContain("SwiftBar");
  expect(text).toContain("https://github.com/swiftbar/SwiftBar");
  // Telling someone to start an app they do not have is the wrong instruction.
  expect(text).not.toContain("open -a SwiftBar");
});

test("status: finds the shim in SwiftBar's configured PluginDirectory, not only the default", async () => {
  const out: string[] = [];
  const { exec } = execStub({ pref: "/Users/somebody/Custom/Plugins", running: true });
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    // ONLY the custom folder has the shim; the default folder does not exist
    existsSync: (p) => p === "/Users/somebody/Custom/Plugins/siltpoke.1m.sh",
    exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).not.toContain("not installed");
});

test("status never writes SwiftBar's pref (read-only command)", async () => {
  const { exec, calls } = execStub({ pref: null, running: false });
  await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: () => false,
    exec,
    write: () => {},
  });
  expect(calls.some((c) => c.startsWith("defaults write"))).toBe(false);
});

test("status: not on macOS → one-line notice, no SwiftBar probing", async () => {
  const out: string[] = [];
  const { exec, calls } = execStub({ running: false });
  const code = await runMenubarCli(["status"], {
    home: "/home/somebody",
    platform: "linux",
    existsSync: () => false,
    exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("macOS-only");
  expect(calls.length).toBe(0);
});

test("remove: deletes the shim from SwiftBar's configured PluginDirectory", async () => {
  const removed: string[] = [];
  const { exec } = execStub({ pref: "/Users/somebody/Custom/Plugins" });
  const code = await runMenubarCli(["remove"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p === "/Users/somebody/Custom/Plugins/siltpoke.1m.sh",
    exec,
    write: () => {},
    rm: (p) => removed.push(p),
  });
  expect(code).toBe(0);
  expect(removed).toEqual(["/Users/somebody/Custom/Plugins/siltpoke.1m.sh"]);
});

// ---------------------------------------------------------------------------
// Second round. The first round's own review found that the fix had rebuilt
// its headline bug in one state, and that three of its promises rested on
// assertions that could not fail. Each test below is one of those.
// ---------------------------------------------------------------------------

const DEFAULT_SHIM = "/Users/somebody/Library/Application Support/SwiftBar/plugins/siltpoke.1m.sh";

test("status: a shim in the default folder does NOT count when SwiftBar reads elsewhere", async () => {
  // Reached by installing normally and THEN changing the folder in SwiftBar's
  // own UI. The leftover copy is not rendered by anything, so reporting a
  // plain "installed, SwiftBar running" here is the very lie this file exists
  // to stop telling.
  const out: string[] = [];
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p === DEFAULT_SHIM,
    exec: execStub({ pref: "/Users/somebody/Custom/Plugins", running: true }).exec,
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  const text = out.join("");
  expect(text).not.toContain("installed, SwiftBar running");
  // ...and not the opposite lie either: the install did happen.
  expect(text).not.toContain("not installed");
  expect(text).toContain(DEFAULT_SHIM);
  expect(text).toContain("/Users/somebody/Custom/Plugins/siltpoke.1m.sh");
});

test("remove: deletes a shim stranded in the default folder rather than reporting a no-op success", async () => {
  const removed: string[] = [];
  const out: string[] = [];
  const code = await runMenubarCli(["remove"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p === DEFAULT_SHIM,
    exec: execStub({ pref: "/Users/somebody/Custom/Plugins" }).exec,
    write: (s) => out.push(s),
    rm: (p) => removed.push(p),
  });
  expect(code).toBe(0);
  expect(removed).toEqual([DEFAULT_SHIM]);
  expect(out.join("")).toContain("removed");
});

test("status: pgrep failing for a reason OTHER than 'no match' is reported as unknown", async () => {
  // pgrep exits 1 for no-match but 2/3 for usage/system errors. Collapsing
  // those into "not running" tells the user to start an app that may already
  // be up.
  const out: string[] = [];
  const code = await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p === DEFAULT_SHIM || p === "/Applications/SwiftBar.app",
    exec: (c, a) => {
      if (c === "defaults" && a[0] === "read") return { status: 1, stdout: "" };
      if (c === "pgrep") return { status: 2, stdout: "" };
      return { status: 0, stdout: "" };
    },
    write: (s) => out.push(s),
  });
  expect(code).toBe(0);
  const text = out.join("");
  expect(text).toContain("could not tell");
  expect(text).not.toContain("open -a SwiftBar");
  expect(text).not.toContain("not running");
});

test("status: the pref is read exactly once per call, in every branch", async () => {
  // Resolving the obeyed path costs a subprocess and the answer is needed in
  // three places; re-resolving made a single `status` spawn four of them.
  for (const [label, existsSync] of [
    ["obeyed shim present", (p: string) => p === DEFAULT_SHIM],
    ["nothing installed", () => false],
    ["stranded copy only", (p: string) => p === DEFAULT_SHIM],
  ] as Array<[string, (p: string) => boolean]>) {
    const pref = label === "stranded copy only" ? "/Users/somebody/Custom/Plugins" : null;
    const { exec, calls } = execStub({ pref, running: true });
    await runMenubarCli(["status"], {
      home: "/Users/somebody",
      platform: "darwin",
      existsSync,
      exec,
      write: () => {},
    });
    const reads = calls.filter((c) => c.startsWith("defaults read"));
    expect(reads.length).toBe(1);
  }
});

test("status: probes are pinned to the exact argv, not just the command name", async () => {
  // A stub matching on the command name alone would stay green through
  // `pgrep -f`, `pgrep -x Swiftbar`, or a wrong pref key.
  const { exec, calls } = execStub({ pref: null, running: true });
  await runMenubarCli(["status"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: (p) => p === DEFAULT_SHIM,
    exec,
    write: () => {},
  });
  expect(calls).toContain("defaults read com.ameba.SwiftBar PluginDirectory");
  expect(calls).toContain("pgrep -x SwiftBar");
});

test("remove never writes SwiftBar's pref either", async () => {
  const { exec, calls } = execStub({ pref: null });
  await runMenubarCli(["remove"], {
    home: "/Users/somebody",
    platform: "darwin",
    existsSync: () => false,
    exec,
    write: () => {},
    rm: () => {},
  });
  expect(calls.some((c) => c.startsWith("defaults write"))).toBe(false);
});

test("remove: not on macOS → one-line notice, no SwiftBar probing", async () => {
  const out: string[] = [];
  const { exec, calls } = execStub({});
  const code = await runMenubarCli(["remove"], {
    platform: "linux",
    home: "/home/somebody",
    existsSync: () => false,
    exec,
    write: (s) => out.push(s),
    rm: () => {},
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("macOS-only");
  expect(calls.length).toBe(0);
});
