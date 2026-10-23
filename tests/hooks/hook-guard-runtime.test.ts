// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The hook guard's RUNTIME half: the one property that matters more than any
// branch — it never writes into the user's session — plus the wiring lines that
// only exist in the wrapper.
//
// WHY THESE DRIVE A REAL PROCESS rather than calling `main` in-process: the
// contract is about what reaches the host's stdout and stderr, and the only
// honest way to assert that is to read those two streams off a child.
//
// The decision branches live in `hook-guard-core.test.ts`. Testing only those
// would pass while this half talked.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NUDGE_TEXT } from "../../src/hooks/hook-guard-core";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "siltpoke-guard-"));
}

/** A home with config.json present, i.e. setup has run. */
function configuredHome(): string {
  const home = tempHome();
  writeFileSync(join(home, "config.json"), "{}");
  return home;
}

// Every child below spreads process.env. Run from a siltpoke-spawned session
// (SILTPOKE_INTERNAL=1 inherited) the guard would exit early and this whole
// suite would go red for a reason that has nothing to do with the code.
// Tests that WANT the marker set it explicitly.
delete process.env.SILTPOKE_INTERNAL;

const guardPath = join(import.meta.dir, "..", "..", "src", "hooks", "hook-guard.ts");

// `process.execPath`, not "bun": one of these cases empties PATH to model a
// shell that cannot find bun, and a bare "bun" here would fail to launch the
// guard at all — the test would then be measuring its own spawn, not the
// guard's behaviour.
async function run(env: Record<string, string>, payload = "{}") {
  const proc = Bun.spawn([process.execPath, guardPath, "stop"], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

describe("silence — asserted on stdout AND stderr, per exit reason", () => {

  test("no config.json: exit 0, nothing on stderr, and the one nudge as systemMessage on stdout", async () => {
    const home = tempHome();
    const { out, err, code } = await run({ SILTPOKE_HOME: home });
    expect(code).toBe(0);
    // Defect [33]: the nudge used to go to stderr, which a host never shows
    // for an exit-0 hook — so it reached nobody while `.nudged` burned it.
    // It is the ONE permitted message, and it must be the one shape a host
    // displays: a single line of JSON carrying `systemMessage`.
    expect(err).toBe("");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({ systemMessage: NUDGE_TEXT });
    expect(existsSync(join(home, ".setup-nudged"))).toBe(true);
  });

  test("the nudge really is once-ever across two separate processes", async () => {
    const home = tempHome();
    await run({ SILTPOKE_HOME: home });
    const second = await run({ SILTPOKE_HOME: home });
    expect(second.err).toBe("");
    expect(second.out).toBe("");
  });

  test("bun unresolvable: exit 0, and BOTH streams empty", async () => {
    const home = configuredHome();
    const { out, err, code } = await run({
      SILTPOKE_HOME: home,
      // Empty PATH + a home with no pointer and no ~/.bun => unresolvable.
      PATH: "",
      HOME: home,
      USERPROFILE: home,
    });
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  test("an unwritable home stays silent instead of nagging every turn", async () => {
    const home = tempHome();
    const locked = join(home, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const first = await run({ SILTPOKE_HOME: join(locked, "siltpoke") });
      const second = await run({ SILTPOKE_HOME: join(locked, "siltpoke") });
      expect(first.err).toBe("");
      expect(second.err).toBe("");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

});

// Separate from the exit paths above because this one actually starts a child
// process: the question is no longer "did the guard stay quiet", it is "did the
// guard stay quiet while something it launched was shouting".
describe("silence — with a bundle actually running", () => {
  // T6 — a bundle that throws must still leave the session clean.
  test("a crashing bundle produces exit 0 and two empty streams", async () => {
    const home = configuredHome();
    const pluginRoot = tempHome();
    mkdirSync(join(pluginRoot, "dist"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "dist", "siltpoke-stop.js"),
      "process.stderr.write('BOOM from the bundle\\n'); process.exit(3);\n",
    );
    const { out, err, code } = await run({
      SILTPOKE_HOME: home,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    expect(code).toBe(0);
    expect(out).toBe("");
    // The bundle's own stderr is discarded by the guard's stdio: "ignore".
    expect(err).toBe("");
  });

});

// The three wiring lines a reviewer found with no coverage at all: the
// argv→mode ternary, the SILTPOKE_HOST env handed to the child, and the
// plugin-root pointer. Each would have been deletable with the suite green —
// the repo already has a name for that shape (`delivery-half-has-no-assertions`).
describe("wiring — the lines that only exist in the wrapper", () => {
  test("the argv→mode ternary really selects the session-start bundle", async () => {
    const home = configuredHome();
    const pluginRoot = tempHome();
    mkdirSync(join(pluginRoot, "dist"), { recursive: true });
    const witness = join(pluginRoot, "which-bundle-ran.txt");
    for (const bundle of ["siltpoke-stop.js", "handle-session-start.js"]) {
      writeFileSync(
        join(pluginRoot, "dist", bundle),
        `require("node:fs").writeFileSync(${JSON.stringify(witness)}, ${JSON.stringify(bundle)});\n`,
      );
    }
    const proc = Bun.spawn([process.execPath, guardPath, "session-start"], {
      env: { ...process.env, SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(readFileSync(witness, "utf8")).toBe("handle-session-start.js");
  });

  test("SILTPOKE_HOST reaches the spawned bundle", async () => {
    const home = configuredHome();
    const pluginRoot = tempHome();
    mkdirSync(join(pluginRoot, "dist"), { recursive: true });
    const witness = join(pluginRoot, "host.txt");
    writeFileSync(
      join(pluginRoot, "dist", "siltpoke-stop.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(witness)}, process.env.SILTPOKE_HOST ?? "<unset>");\n`,
    );
    const proc = Bun.spawn([process.execPath, guardPath, "stop"], {
      env: {
        ...process.env,
        SILTPOKE_HOME: home,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        QODER_PLUGIN_ROOT: pluginRoot,
      },
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    // qoder wins the host-family question even though claude won the root one —
    // the two ladders disagreeing is the intended behaviour, asserted here.
    expect(readFileSync(witness, "utf8")).toBe("qoder");
  });

});

// `hooks/session-start.sh:12-34` writes the pointer BEFORE any gate, and the
// first draft of the port gated it. The statusline and the daemon autostart
// unit read that file; a stale pointer after a plugin upgrade is how those
// surfaces end up naming a directory that is gone.
describe("wiring — the plugin-root pointer", () => {
  test("session-start writes it even with no config and no bundle", async () => {
    // `hooks/session-start.sh:12-34` writes it BEFORE any gate. The statusline
    // and the daemon autostart unit read it; a stale pointer after a plugin
    // upgrade is how those surfaces end up pointing at a directory that is gone.
    const home = tempHome(); // deliberately NOT configured
    const proc = Bun.spawn([process.execPath, guardPath, "session-start"], {
      env: { ...process.env, SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: "/some/plugin/root" },
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(readFileSync(join(home, "plugin-root"), "utf8")).toBe("/some/plugin/root");
  });

  test("stop mode does NOT write the pointer — only session-start does", async () => {
    const home = configuredHome();
    await run({ SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: "/some/plugin/root" });
    expect(existsSync(join(home, "plugin-root"))).toBe(false);
  });

  test("defect [73]: under SILTPOKE_INTERNAL=1 neither mode writes anything (no pointer, no nudge marker)", async () => {
    for (const mode of ["session-start", "stop"]) {
      const home = tempHome(); // not configured: unguarded, both modes would write
      const proc = Bun.spawn([process.execPath, guardPath, mode], {
        env: { ...process.env, SILTPOKE_HOME: home, SILTPOKE_INTERNAL: "1", CLAUDE_PLUGIN_ROOT: "/some/plugin/root" },
        stdin: new TextEncoder().encode("{}"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toBe("");
      expect(readdirSync(home)).toEqual([]);
    }
  });

  for (const mode of ["session-start", "stop"]) {
    test(`--self-test ${mode} still prints its one line under SILTPOKE_INTERNAL=1 and writes nothing`, async () => {
      const home = tempHome(); // unconfigured: unguarded, stop would write .setup-nudged
      const proc = Bun.spawn([process.execPath, guardPath, mode, "--self-test"], {
        env: { ...process.env, SILTPOKE_HOME: home, SILTPOKE_INTERNAL: "1", CLAUDE_PLUGIN_ROOT: "/some/plugin/root" },
        stdin: new TextEncoder().encode("{}"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out.startsWith("siltpoke-guard ")).toBe(true);
      expect(out.trimEnd().split("\n")).toHaveLength(1);
      expect(readdirSync(home)).toEqual([]);
    });
  }

  test("--self-test is the ONE mode that prints, and prints exactly one line", async () => {
    const home = tempHome();
    const proc = Bun.spawn([process.execPath, guardPath, "stop", "--self-test"], {
      env: { ...process.env, SILTPOKE_HOME: home },
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out.startsWith("siltpoke-guard ")).toBe(true);
  });
});
