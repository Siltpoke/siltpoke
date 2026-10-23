// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { type DiskProbes, homeScopedExec, readDisk } from "../../src/cli/uninstall-disk";
import type { Receipt, ReceiptEntry, ReceiptKind } from "../../src/installer/receipt";

// `[61]` PR 2, plan P2.1 (spec §2.1, §8 D-A): what the planner is told about
// the disk. Every probe is a fake over a map, so no test reads a real home.

const HOME = "/h";
const ENV = { HOME };
const SETTINGS = "/h/.claude/settings.json";
const AGY_SETTINGS = "/h/.gemini/antigravity-cli/settings.json";
const DAEMON_PLIST = "/h/Library/LaunchAgents/io.siltpoke.daemon.plist";
const SWIFTBAR_PLIST = "/h/Library/LaunchAgents/io.siltpoke.swiftbar.plist";
const DEFAULT_SHIM = "/h/Library/Application Support/SwiftBar/plugins/siltpoke.1m.sh";
const OUR_SHIM = '#!/bin/bash\nexec "/h/.bun/bin/bun" "/h/.siltpoke/app/dist/siltpoke-card.js" --menubar\n';
const OUR_LINE = { statusLine: { type: "command", command: "sh /h/.siltpoke/bin/statusline.sh" } };
const SOURCE_LINE = { statusLine: { type: "command", command: "bun /repo/src/face/wrapper.ts" } };
const SOURCE_AGY_LINE = { statusLine: { command: "/h/.bun/bin/bun /repo/src/face/wrapper.ts --agent antigravity" } };

interface Fake {
  files?: Record<string, string>;
  /** `defaults read com.ameba.SwiftBar PluginDirectory`; undefined = unset. */
  pluginDir?: string;
  platform?: NodeJS.Platform;
  tools?: string[];
}

function probes(fake: Fake): DiskProbes {
  const files = fake.files ?? {};
  return {
    platform: fake.platform ?? "darwin",
    exists: (p) => p in files,
    readText: (p) => files[p] ?? null,
    linksIn: () => [],
    namesIn: () => [],
    exec: (cmd, args) =>
      cmd === "defaults" && args[0] === "read" && fake.pluginDir !== undefined
        ? { status: 0, stdout: `${fake.pluginDir}\n` }
        : { status: 1, stdout: "" },
    toolPresent: (e) => (fake.tools ?? []).includes(e.id),
  };
}

function entry(id: string, kind: ReceiptKind, target: string, undo: Record<string, unknown>): ReceiptEntry {
  return {
    id,
    kind,
    target,
    byUs: true,
    level: kind === "outside-tool" ? "purge" : "uninstall",
    undo,
    state: "done",
    at: "2026-10-05T00:00:00.000Z",
    siltpokeVersion: "1.3.0",
  };
}

function receipt(...entries: ReceiptEntry[]): Receipt {
  return { version: 1, entries, projects: [] };
}

const json = (v: unknown) => JSON.stringify(v);

/** One receipt entry against one disk: is it reported present? */
function present(e: ReceiptEntry, fake: Fake): boolean {
  return readDisk(receipt(e), ENV, probes(fake)).present.has(e.id);
}

// --- receipt entries: still there? -----------------------------------------

const claudeLine = entry("statusline:claude-code", "statusline", SETTINGS, { type: "restore-statusline", inner: "/h/.siltpoke/inner.txt" });

test("disk: Claude's status line is present while settings.json still runs siltpoke's shim or the source wrapper", () => {
  expect(present(claudeLine, { files: { [SETTINGS]: json(OUR_LINE) } })).toBe(true);
  expect(present(claudeLine, { files: { [SETTINGS]: json(SOURCE_LINE) } })).toBe(true);
});

test("disk: Claude's status line is gone when the user's own command is there, the key is missing, the file is not JSON, or there is no file", () => {
  expect(present(claudeLine, { files: { [SETTINGS]: json({ statusLine: { command: "my-own-line.sh" } }) } })).toBe(false);
  expect(present(claudeLine, { files: { [SETTINGS]: json({ model: "x" }) } })).toBe(false);
  expect(present(claudeLine, { files: { [SETTINGS]: "{ not json" } })).toBe(false);
  expect(present(claudeLine, {})).toBe(false);
});

const agyLine = entry("statusline:antigravity", "statusline", AGY_SETTINGS, { type: "unwire-agy-statusline" });

test("disk: Antigravity's status line is present only while the command has siltpoke's shape", () => {
  expect(present(agyLine, { files: { [AGY_SETTINGS]: json(SOURCE_AGY_LINE) } })).toBe(true);
  expect(present(agyLine, { files: { [AGY_SETTINGS]: json({ statusLine: { command: "/opt/interface/wrapper.sh" } }) } })).toBe(false);
  expect(present(agyLine, {})).toBe(false);
});

const codexHook = entry("hook:codex", "host-hook", "/h/.codex/hooks.json", {
  type: "remove-hook-entries",
  events: ["Stop", "SessionStart"],
  match: "/repo",
});

test("disk: a hooks file is present while one of its commands still points into the recorded install", () => {
  const ours = json({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/on-stop.ts" }] }] } });
  const theirs = json({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /other/thing.ts" }] }] } });
  expect(present(codexHook, { files: { "/h/.codex/hooks.json": ours } })).toBe(true);
  expect(present(codexHook, { files: { "/h/.codex/hooks.json": theirs } })).toBe(false);
  expect(present(codexHook, {})).toBe(false);
});

test("disk: a Windows install root is found in the file's JSON-escaped form too", () => {
  const win = { ...codexHook, undo: { ...codexHook.undo, match: "C:\\Users\\v\\repo" } };
  const text = json({ hooks: { Stop: [{ hooks: [{ command: "bun C:\\Users\\v\\repo\\src\\hooks\\on-stop.ts" }] }] } });
  expect(text).not.toContain("C:\\Users\\v\\repo\\src"); // on disk the backslashes are doubled
  expect(present(win, { files: { "/h/.codex/hooks.json": text } })).toBe(true);
});

test("disk: a hook entry with no usable match string is never reported present", () => {
  const noMatch = { ...codexHook, undo: { type: "remove-hook-entries", match: "" } };
  expect(present(noMatch, { files: { "/h/.codex/hooks.json": "{}" } })).toBe(false);
});

const agyHook = entry("hook:antigravity", "host-hook", "/h/.gemini/antigravity/hooks.json", { type: "remove-json-key", key: "siltpoke" });

test("disk: Antigravity's hooks key is present while the top-level key is there", () => {
  expect(present(agyHook, { files: { [agyHook.target]: json({ siltpoke: {}, other: {} }) } })).toBe(true);
  expect(present(agyHook, { files: { [agyHook.target]: json({ other: { siltpoke: 1 } }) } })).toBe(false);
  expect(present(agyHook, { files: { [agyHook.target]: "nope" } })).toBe(false);
});

for (const [type, undo] of [
  ["unload-and-delete", { type: "unload-and-delete" }],
  ["remove-if-hash", { type: "remove-if-hash", sha256: "abc" }],
  ["remove-link", { type: "remove-link", under: "/repo/.claude-plugin/commands" }],
] as const) {
  test(`disk: a ${type} entry is present exactly while its target exists`, () => {
    const e = entry("file:/h/x", "file", "/h/x", undo);
    expect(present(e, { files: { "/h/x": "" } })).toBe(true);
    expect(present(e, {})).toBe(false);
  });
}

const pref = entry("pref:com.ameba.SwiftBar.PluginDirectory", "macos-pref", "com.ameba.SwiftBar", {
  type: "defaults-delete",
  domain: "com.ameba.SwiftBar",
  key: "PluginDirectory",
});

test("disk: a macOS pref is present while `defaults read` returns a value, and never off macOS", () => {
  expect(present(pref, { pluginDir: "/h/plugins" })).toBe(true);
  expect(present(pref, {})).toBe(false);
  expect(present(pref, { pluginDir: "/h/plugins", platform: "linux" })).toBe(false);
});

test("disk: an outside tool is whatever the tool probe says", () => {
  const model = entry("tool:ollama-model", "outside-tool", "qwen2.5-coder:7b", { type: "ollama-rm", model: "qwen2.5-coder:7b" });
  expect(present(model, { tools: ["tool:ollama-model"] })).toBe(true);
  expect(present(model, {})).toBe(false);
});

test("disk: an undo type this version does not know is reported present, so the plan lists it rather than calling it gone", () => {
  const odd = entry("widget:future", "file", "/h/nowhere", { type: "from-a-newer-version" });
  expect(present(odd, {})).toBe(true);
});

// --- no receipt: what names siltpoke (spec §8 D-A) --------------------------

const everything: Fake = {
  files: {
    [SETTINGS]: json(OUR_LINE),
    [AGY_SETTINGS]: json(SOURCE_AGY_LINE),
    [DAEMON_PLIST]: "<plist/>",
    [SWIFTBAR_PLIST]: "<plist/>",
    [DEFAULT_SHIM]: OUR_SHIM,
  },
};

test("disk, no receipt: the five things PR 1 already removed are found by their content or name", () => {
  const { found, present: p } = readDisk(null, ENV, probes(everything));
  expect(found).toEqual([
    { id: "statusline:claude-code", kind: "statusline", target: SETTINGS },
    { id: "statusline:antigravity", kind: "statusline", target: AGY_SETTINGS },
    { id: "launch-agent:daemon", kind: "launch-agent", target: DAEMON_PLIST },
    { id: `file:${DEFAULT_SHIM}`, kind: "file", target: DEFAULT_SHIM },
    { id: "launch-agent:swiftbar", kind: "launch-agent", target: SWIFTBAR_PLIST },
  ]);
  expect(p.size).toBe(0);
});

test("disk: the data folder and a daemon pidfile are found on every platform, under SILTPOKE_HOME when it is set", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const { found } = readDisk(null, ENV, probes({ platform, files: { "/h/.siltpoke": "", "/h/.siltpoke/siltpoked.pid": "41" } }));
    expect(found).toEqual([
      { id: "process:daemon", kind: "file", target: "/h/.siltpoke/siltpoked.pid" },
      { id: "data:home", kind: "user-data", target: "/h/.siltpoke" },
    ]);
  }
  const moved = readDisk(null, { HOME, SILTPOKE_HOME: "/data/sp" }, probes({ files: { "/h/.siltpoke": "", "/data/sp": "" } }));
  expect(moved.found).toEqual([{ id: "data:home", kind: "user-data", target: "/data/sp" }]);
  // A folder with no pidfile has no server to stop.
  expect(readDisk(null, ENV, probes({ files: { "/h/.siltpoke": "" } })).found.map((f) => f.id)).toEqual(["data:home"]);
});

test("disk, no receipt: nothing of siltpoke's on disk finds nothing", () => {
  const theirs: Fake = {
    files: {
      [SETTINGS]: json({ statusLine: { command: "my-own-line.sh" } }),
      [AGY_SETTINGS]: json({ statusLine: { command: "/opt/interface/wrapper.sh" } }),
    },
  };
  expect(readDisk(null, ENV, probes(theirs)).found).toEqual([]);
  expect(readDisk(null, ENV, probes({})).found).toEqual([]);
});

// D-A is "the content is the record". The source wrapper's command has no
// siltpoke-only path in it, so without a receipt it is not claimed.
test("disk, no receipt: a status line that only looks like the source wrapper is not claimed", () => {
  const { found } = readDisk(null, ENV, probes({ files: { [SETTINGS]: json(SOURCE_LINE) } }));
  expect(found).toEqual([]);
});

test("disk, no receipt: the shim is looked for where SwiftBar's setting points, and a file there that is not siltpoke's is left out", () => {
  const moved = "/h/my-plugins/siltpoke.1m.sh";
  const ours = readDisk(null, ENV, probes({ files: { [moved]: OUR_SHIM }, pluginDir: "/h/my-plugins" }));
  expect(ours.found.filter((f) => f.kind === "file")).toEqual([{ id: `file:${moved}`, kind: "file", target: moved }]);

  const theirs = readDisk(null, ENV, probes({ files: { [moved]: "#!/bin/bash\necho mine\n" }, pluginDir: "/h/my-plugins" }));
  expect(theirs.found.filter((f) => f.kind === "file")).toEqual([]);
});

test("disk, no receipt: a shim left in the default folder while SwiftBar reads another is still found", () => {
  const { found } = readDisk(null, ENV, probes({ files: { [DEFAULT_SHIM]: OUR_SHIM }, pluginDir: "/h/my-plugins" }));
  expect(found.filter((f) => f.kind === "file")).toEqual([{ id: `file:${DEFAULT_SHIM}`, kind: "file", target: DEFAULT_SHIM }]);
});

test("disk, no receipt: SwiftBar's plugin-folder setting is reported, as a pref whose owner is unknown", () => {
  const { found } = readDisk(null, ENV, probes({ pluginDir: "/h/my-plugins" }));
  expect(found).toEqual([
    { id: "pref:com.ameba.SwiftBar.PluginDirectory", kind: "macos-pref", target: "com.ameba.SwiftBar" },
  ]);
});

test("disk: off macOS there is no menu bar to find, and the daemon unit is the systemd one", () => {
  const unit = "/h/.config/systemd/user/siltpoked.service";
  const { found } = readDisk(null, ENV, probes({
    platform: "linux",
    pluginDir: "/h/plugins",
    files: { [unit]: "[Unit]", [DEFAULT_SHIM]: OUR_SHIM, [SWIFTBAR_PLIST]: "<plist/>", [DAEMON_PLIST]: "<plist/>" },
  }));
  expect(found).toEqual([{ id: "launch-agent:daemon", kind: "launch-agent", target: unit }]);
});

test("disk: with a receipt, found still lists what is on disk — the planner decides which record wins", () => {
  const view = readDisk(receipt(claudeLine), ENV, probes(everything));
  expect(view.present.has(claudeLine.id)).toBe(true);
  expect(view.found.map((f) => f.id)).toContain(claudeLine.id);
});

// Found by running `uninstall --plan` under a throwaway HOME (2026-10-05): the
// plan listed the real home's shim, because `defaults` ignores HOME.
const ID_P = "me:********:501:20::0:0:Me Myself:/Users/me:/bin/zsh\n";

function machine(idOutput: { status: number; stdout: string }) {
  const seen: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    seen.push(cmd);
    if (cmd === "/usr/bin/id") return idOutput;
    return { status: 0, stdout: `/real/${args.join(" ")}\n` };
  };
  return { seen, exec };
}

test("homeScopedExec: under a home that is not the account's, `defaults` is not run and reads as unset", () => {
  const m = machine({ status: 0, stdout: ID_P });
  const sandbox = homeScopedExec(m.exec, { HOME: "/tmp/sandbox" });
  expect(sandbox("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"])).toEqual({ status: 1, stdout: "" });
  expect(sandbox("defaults", ["read", "a", "b"]).status).toBe(1);
  expect(m.seen).toEqual(["/usr/bin/id"]); // asked once; `defaults` never ran
  expect(sandbox("pgrep", ["x"]).status).toBe(0); // anything else still runs
});

test("homeScopedExec: under the account's own home `defaults` is followed, trailing slash or not", () => {
  for (const HOME of ["/Users/me", "/Users/me/"]) {
    const m = machine({ status: 0, stdout: ID_P });
    expect(homeScopedExec(m.exec, { HOME })("defaults", ["read", "a", "b"]).stdout).toBe("/real/read a b\n");
  }
});

test("homeScopedExec: when the account's home cannot be read, `defaults` is not followed", () => {
  for (const bad of [{ status: 1, stdout: "" }, { status: 0, stdout: "garbage\n" }, { status: 0, stdout: "a:b:c:d:e:f:g:h:relative:sh\n" }]) {
    const m = machine(bad);
    expect(homeScopedExec(m.exec, { HOME: "/Users/me" })("defaults", ["read", "a", "b"]).status).toBe(1);
  }
  // A failed `id` is not believed even when it printed the matching home.
  const failed = machine({ status: 1, stdout: ID_P });
  expect(homeScopedExec(failed.exec, { HOME: "/Users/me" })("defaults", ["read", "a", "b"]).status).toBe(1);
  // A home that is not an absolute path is not a home, even when HOME says the same.
  const relative = machine({ status: 0, stdout: "a:b:c:d:e:f:g:h:relative:sh\n" });
  expect(homeScopedExec(relative.exec, { HOME: "relative" })("defaults", ["read", "a", "b"]).status).toBe(1);
});

test("homeScopedExec: nothing is spawned until a `defaults` question comes up", () => {
  const m = machine({ status: 0, stdout: ID_P });
  homeScopedExec(m.exec, { HOME: "/Users/me" })("pgrep", ["x"]);
  expect(m.seen).toEqual(["pgrep"]);
});

test("homeScopedExec + readDisk: a sandbox home never reports the account's SwiftBar folder", () => {
  const accountShim = "/Users/me/plugins/siltpoke.1m.sh";
  const p = probes({ files: { [accountShim]: OUR_SHIM }, pluginDir: "/Users/me/plugins" });
  const scoped = { ...p, exec: homeScopedExec(p.exec, ENV, () => "/Users/me") };
  expect(readDisk(null, ENV, p).found.map((f) => f.target)).toContain(accountShim); // what happened
  expect(readDisk(null, ENV, scoped).found).toEqual([]);
});
