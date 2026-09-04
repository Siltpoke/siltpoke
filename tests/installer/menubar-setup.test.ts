import { expect, test } from "bun:test";
import { runMenubarSetup } from "../../src/installer/menubar-setup";

function fakeIO(answers: string[]) {
  let i = 0;
  const out: string[] = [];
  return {
    io: {
      readLine: async () => answers[i++] ?? "",
      write: (s: string) => out.push(s),
    },
    out,
  };
}

test("non-darwin: zero side-effects", async () => {
  const writes: string[] = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO([]).io,
    platform: "linux",
    writeFile: (p) => writes.push(p),
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      return { status: 0, stdout: "" };
    },
  });
  expect(r.reason).toBe("not-darwin");
  expect(r.installed).toBe(false);
  expect(r.wroteShim).toBe(false);
  expect(writes.length).toBe(0);
  expect(execs.length).toBe(0);
});

test("declining install writes nothing", async () => {
  const writes: string[] = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO(["n"]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: () => false,
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      return { status: c === "which" ? 0 : 1, stdout: "" }; // brew present, swiftbar absent
    },
    writeFile: (p) => writes.push(p),
  });
  expect(r.reason).toBe("declined");
  expect(r.installed).toBe(false);
  expect(r.wroteShim).toBe(false);
  expect(writes.length).toBe(0);
  // ZERO silent side-effects (abandoned-tmux invariant): a `brew list` /
  // detection probe before the prompt is fine, but NO side-effecting exec may
  // fire on the declined path — no install, no mkdir, no chmod, no open.
  expect(execs.some((e) => e.startsWith("brew install"))).toBe(false);
  expect(execs.some((e) => e.startsWith("mkdir"))).toBe(false);
  expect(execs.some((e) => e.startsWith("chmod"))).toBe(false);
  expect(execs.some((e) => e.startsWith("open"))).toBe(false);
});

test("no brew on PATH → reason no-brew, zero writes", async () => {
  const writes: string[] = [];
  const { io, out } = fakeIO(["y"]); // consents to install, but brew itself is missing
  const r = await runMenubarSetup({
    io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: () => false,
    exec: () => ({ status: 1, stdout: "" }), // no brew at all, swiftbar absent
    writeFile: (p) => writes.push(p),
  });
  expect(r.reason).toBe("no-brew");
  expect(r.installed).toBe(false);
  expect(r.wroteShim).toBe(false);
  expect(writes.length).toBe(0);
  expect(out.join("")).toMatch(/https?:\/\//);
});

test("accepting writes the plugin shim", async () => {
  const writes: Array<[string, string]> = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO(["y"]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: () => false,
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      if (c === "which" && a[0] === "brew") return { status: 0, stdout: "/opt/homebrew/bin/brew" };
      if (c === "which" && a[0] === "bun") return { status: 0, stdout: "/opt/homebrew/bin/bun\n" };
      return { status: 0, stdout: "" };
    },
    writeFile: (p, c) => writes.push([p, c]),
  });
  expect(r.reason).toBe("ok");
  expect(r.installed).toBe(true);
  expect(r.wroteShim).toBe(true);
  expect(writes.some(([p]) => p.endsWith("siltpoke.1m.sh"))).toBe(true);
  const shim = writes.find(([p]) => p.endsWith(".sh"));
  expect(shim).toBeDefined();
  expect(shim?.[1]).toContain("wrapper.ts");
  expect(shim?.[1]).toContain("--menubar");
  expect(shim?.[1]).toContain("/opt/homebrew/bin/bun");
  expect(execs.some((e) => e.startsWith("open -a SwiftBar"))).toBe(true);
  expect(execs.some((e) => e.includes("chmod") && e.includes("siltpoke.1m.sh"))).toBe(true);
});

test("nonInteractive + SwiftBar absent → no-swiftbar, no prompt read, no brew, prints link", async () => {
  const writes: string[] = [];
  const execs: string[] = [];
  const { io, out } = fakeIO([]); // NO answers queued — a non-interactive run must not readLine
  const r = await runMenubarSetup({
    io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: () => false, // SwiftBar.app absent
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      return { status: 1, stdout: "" }; // swiftbar cask absent too
    },
    writeFile: (p) => writes.push(p),
    nonInteractive: true,
  });
  expect(r.reason).toBe("no-swiftbar");
  expect(r.installed).toBe(false);
  expect(r.wroteShim).toBe(false);
  expect(writes.length).toBe(0);
  expect(execs.some((e) => e.startsWith("brew install"))).toBe(false); // no auto-brew without a prompt
  expect(out.join("")).toMatch(/https?:\/\//); // pointed the user at the download
});

test("rendererPath overrides the shim renderer (plugin bundled card, not src wrapper.ts)", async () => {
  const writes: Array<[string, string]> = [];
  const r = await runMenubarSetup({
    io: fakeIO([]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: (p) => p === "/Applications/SwiftBar.app", // present → consent skipped
    exec: (c, a) => {
      if (c === "which" && a[0] === "bun") return { status: 0, stdout: "/opt/homebrew/bin/bun\n" };
      return { status: 0, stdout: "" };
    },
    writeFile: (p, c) => writes.push([p, c]),
    nonInteractive: true,
    rendererPath: "/plugin/root/dist/siltpoke-card.js",
  });
  expect(r.reason).toBe("ok");
  const shim = writes.find(([p]) => p.endsWith(".sh"));
  expect(shim?.[1]).toContain("/plugin/root/dist/siltpoke-card.js");
  expect(shim?.[1]).not.toContain("wrapper.ts");
});

test("honors SwiftBar's existing PluginDirectory pref (writes shim there, does not overwrite the pref)", async () => {
  const writes: Array<[string, string]> = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO([]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: (p) => p === "/Applications/SwiftBar.app",
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      if (c === "defaults" && a[0] === "read") return { status: 0, stdout: "/Users/t/Custom/Plugins\n" };
      if (c === "which" && a[0] === "bun") return { status: 0, stdout: "/opt/homebrew/bin/bun" };
      return { status: 0, stdout: "" };
    },
    writeFile: (p, c) => writes.push([p, c]),
  });
  expect(r.reason).toBe("ok");
  // shim written into the user's configured folder, not our default
  expect(writes.some(([p]) => p === "/Users/t/Custom/Plugins/siltpoke.1m.sh")).toBe(true);
  expect(writes.some(([p]) => p.includes("Application Support/SwiftBar/plugins"))).toBe(false);
  // existing pref honored — no `defaults write` overwrite
  expect(execs.some((e) => e.startsWith("defaults write"))).toBe(false);
});

test("no pref set → points SwiftBar at our default dir via defaults write, then writes shim there", async () => {
  const writes: Array<[string, string]> = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO([]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: (p) => p === "/Applications/SwiftBar.app",
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      if (c === "defaults" && a[0] === "read") return { status: 1, stdout: "" }; // pref unset
      if (c === "which" && a[0] === "bun") return { status: 0, stdout: "/opt/homebrew/bin/bun" };
      return { status: 0, stdout: "" };
    },
    writeFile: (p, c) => writes.push([p, c]),
  });
  expect(r.reason).toBe("ok");
  expect(execs.some((e) => e.startsWith("defaults write com.ameba.SwiftBar PluginDirectory"))).toBe(true);
  expect(writes.some(([p]) => p.endsWith("Application Support/SwiftBar/plugins/siltpoke.1m.sh"))).toBe(true);
});

test("SwiftBar already installed (app present) skips consent prompt and proceeds", async () => {
  const writes: Array<[string, string]> = [];
  const execs: string[] = [];
  const { io, out } = fakeIO([]); // no answers consumed — no prompt should be asked
  const r = await runMenubarSetup({
    io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: (p) => p === "/Applications/SwiftBar.app",
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      if (c === "which" && a[0] === "bun") return { status: 0, stdout: "/opt/homebrew/bin/bun" };
      return { status: 0, stdout: "" };
    },
    writeFile: (p, c) => writes.push([p, c]),
  });
  expect(r.reason).toBe("ok");
  expect(r.wroteShim).toBe(true);
  expect(out.join("")).toBe(""); // no prompt written since no ask needed
});

test("ok path registers the SwiftBar login-item (autostart:true) (AC20 wiring)", async () => {
  const writes: string[] = [];
  const execs: string[] = [];
  const r = await runMenubarSetup({
    io: fakeIO([]).io,
    platform: "darwin",
    home: "/Users/t",
    existsSync: () => true, // SwiftBar.app present → install path + autostart guard both pass
    exec: (c, a) => {
      execs.push([c, ...a].join(" "));
      return { status: 0, stdout: "" };
    },
    writeFile: (p) => writes.push(p),
  });
  expect(r.reason).toBe("ok");
  expect(r.installed).toBe(true);
  expect(r.autostart).toBe(true);
  // the login-item was (re)loaded under launchd
  expect(execs.some((e) => e.includes("launchctl bootstrap") && e.includes("io.siltpoke.swiftbar"))).toBe(true);
  // a plist file was written
  expect(writes.some((p) => p.endsWith("io.siltpoke.swiftbar.plist"))).toBe(true);
});
