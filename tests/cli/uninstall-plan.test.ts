// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { buildPlan, type DiskView, type FoundOnDisk, type PlanGroup } from "../../src/cli/uninstall-plan";
import type { Receipt, ReceiptEntry, ReceiptKind } from "../../src/installer/receipt";

// `[61]` PR 2, plan P2.1 (spec §3, §5, §8 D-A). buildPlan is pure: the receipt
// and what is on disk go in as data, so every row below is a fixture, and no
// test here can touch a real home.

function entry(
  id: string,
  kind: ReceiptKind,
  target: string,
  over: Partial<ReceiptEntry> = {},
): ReceiptEntry {
  return {
    id,
    kind,
    target,
    byUs: true,
    level: kind === "outside-tool" || kind === "user-data" ? "purge" : "uninstall",
    undo: { type: "test" },
    state: "done",
    at: "2026-10-05T00:00:00.000Z",
    siltpokeVersion: "1.3.0",
    ...over,
  };
}

function receipt(...entries: ReceiptEntry[]): Receipt {
  return { version: 1, entries, projects: [] };
}

function disk(present: string[], found: FoundOnDisk[] = []): DiskView {
  return { present: new Set(present), found };
}

function group(groups: PlanGroup[], id: string): PlanGroup {
  const g = groups.find((x) => x.id === id);
  if (!g) throw new Error(`no group ${id} in [${groups.map((x) => x.id).join(", ")}]`);
  return g;
}

/** `group/item=status` for every item, so a row states the whole plan. */
function shape(groups: PlanGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => `${g.id}/${i.id}=${i.status}`));
}

const SHIM = "/h/Library/Application Support/SwiftBar/Plugins/siltpoke.1m.sh";
const CMD = "/h/.claude/commands/siltpoke-doctor.md";

const codexHook = entry("hook:codex", "host-hook", "/h/.codex/hooks.json");
const claudeLine = entry("statusline:claude-code", "statusline", "/h/.claude/settings.json");
const claudeHook = entry("hook:claude-code", "host-hook", "/h/.claude/settings.json");
const cmdFile = entry(`file:${CMD}`, "file", CMD);
const agyLine = entry("statusline:antigravity", "statusline", "/h/.gemini/antigravity/settings.json");
const agyHook = entry("hook:antigravity", "host-hook", "/h/.gemini/antigravity/hooks.json");
const daemonUnit = entry("launch-agent:daemon", "launch-agent", "/h/Library/LaunchAgents/io.siltpoke.daemon.plist");
const shim = entry(`file:${SHIM}`, "file", SHIM);
const loginItem = entry("launch-agent:swiftbar", "launch-agent", "/h/Library/LaunchAgents/io.siltpoke.swiftbar.plist");
const pref = entry("pref:com.ameba.SwiftBar.PluginDirectory", "macos-pref", "com.ameba.SwiftBar");

const everyWiring = [codexHook, claudeLine, claudeHook, cmdFile, agyLine, agyHook, daemonUnit, shim, loginItem, pref];

test("plan: each tool is one group, and the menu bar is shim + login item + pref together", () => {
  const { groups } = buildPlan(receipt(...everyWiring), disk(everyWiring.map((e) => e.id)));

  expect(shape(groups)).toEqual([
    "claude-code/statusline:claude-code=remove",
    "claude-code/hook:claude-code=remove",
    `claude-code/file:${CMD}=remove`,
    "codex/hook:codex=remove",
    "antigravity/statusline:antigravity=remove",
    "antigravity/hook:antigravity=remove",
    "dashboard/launch-agent:daemon=remove",
    `menubar/file:${SHIM}=remove`,
    "menubar/launch-agent:swiftbar=remove",
    "menubar/pref:com.ameba.SwiftBar.PluginDirectory=remove",
  ]);
  for (const g of groups) {
    expect(g.offer).toBe("remove");
    expect(g.level).toBe("uninstall");
    expect(g.title.length).toBeGreaterThan(0);
  }
});

test("plan: codebuddy and qoder each get their own group", () => {
  const a = entry("hook:codebuddy", "host-hook", "/h/.codebuddy/settings.json");
  const b = entry("hook:qodercli", "host-hook", "/h/.qoder/settings.json");
  const { groups } = buildPlan(receipt(a, b), disk([a.id, b.id]));
  expect(groups.map((g) => g.id)).toEqual(["codebuddy", "qoder"]);
});

test("plan: a host this version has no name for still gets its own group, after the named hosts", () => {
  const cursor = entry("hook:cursor", "host-hook", "/h/.cursor/hooks.json");
  const { groups } = buildPlan(receipt(daemonUnit, cursor, agyHook), disk([daemonUnit.id, cursor.id, agyHook.id]));
  expect(groups.map((g) => g.id)).toEqual(["antigravity", "cursor", "dashboard"]);
  expect(group(groups, "cursor").title).toContain("cursor");
  expect(group(groups, "cursor").offer).toBe("remove");
});

// A hook id is `hook:<host>`, and the host becomes the group id. A "host" named
// like a non-host group must not put a hook file into that group's yes.
for (const id of ["hook:dashboard", "hook:menubar", "hook:general-tools", "statusline:tool:plc", "hook:Not A Host"]) {
  test(`plan: ${id} is not a host — listed under "other", never offered`, () => {
    const odd = entry(id, "host-hook", "/h/x.json");
    const { groups } = buildPlan(receipt(odd), disk([odd.id]));
    expect(shape(groups)).toEqual([`other/${id}=never-offered`]);
  });
}

test("plan: a done entry that is no longer on disk is reported as already gone, and the group offers nothing", () => {
  const { groups } = buildPlan(receipt(codexHook), disk([]));
  expect(shape(groups)).toEqual(["codex/hook:codex=already-gone"]);
  expect(group(groups, "codex").offer).toBe("list-only");
});

// Spec §2.1 — the end-to-end half of AC3: a crash between recordBefore and the
// action leaves `pending`; the planner asks the disk.
test("plan: a pending entry still on disk is offered", () => {
  const pending = { ...codexHook, state: "pending" as const };
  const { groups } = buildPlan(receipt(pending), disk([pending.id]));
  expect(shape(groups)).toEqual(["codex/hook:codex=remove"]);
});

test("plan: a pending entry that is not on disk is dropped — no group, no 'already gone'", () => {
  const pending = { ...codexHook, state: "pending" as const };
  const { groups } = buildPlan(receipt(pending, claudeLine), disk([claudeLine.id]));
  expect(shape(groups)).toEqual(["claude-code/statusline:claude-code=remove"]);
});

test("plan: something that was there before siltpoke is listed and never offered", () => {
  const theirs = { ...pref, byUs: false };
  const { groups } = buildPlan(receipt(shim, theirs), disk([shim.id, theirs.id]));
  expect(shape(groups)).toEqual([
    `menubar/file:${SHIM}=remove`,
    "menubar/pref:com.ameba.SwiftBar.PluginDirectory=kept-not-ours",
  ]);
  // The group is still offered: its one removable item is ours.
  expect(group(groups, "menubar").offer).toBe("remove");
});

test("plan: a group whose only item is not ours is list-only", () => {
  const theirs = { ...pref, byUs: false };
  const { groups } = buildPlan(receipt(theirs), disk([theirs.id]));
  expect(group(groups, "menubar").offer).toBe("list-only");
});

// Spec §5.
test("plan: the Ollama model, PLC and the SwiftBar app are purge-level groups, offered only when ours", () => {
  const model = entry("tool:ollama-model", "outside-tool", "qwen2.5-coder:7b");
  const plc = entry("tool:plc", "outside-tool", "project-lifecycle@project-life-cycle", { byUs: false });
  const app = entry("tool:swiftbar", "outside-tool", "/Applications/SwiftBar.app");
  const { groups } = buildPlan(receipt(model, plc, app), disk([model.id, plc.id, app.id]));

  expect(shape(groups)).toEqual([
    "tool:ollama-model/tool:ollama-model=remove",
    "tool:plc/tool:plc=kept-not-ours",
    "tool:swiftbar/tool:swiftbar=remove",
  ]);
  expect(groups.map((g) => g.level)).toEqual(["purge", "purge", "purge"]);
  expect(groups.map((g) => g.offer)).toEqual(["remove", "list-only", "remove"]);
});

test("plan: bun, git, Claude Code and codex are never offered, even when siltpoke installed them", () => {
  const tools = ["bun", "git", "claude-code", "codex"].map((t) => entry(`tool:${t}`, "outside-tool", t));
  const { groups } = buildPlan(receipt(...tools), disk(tools.map((t) => t.id)));

  expect(shape(groups)).toEqual([
    "general-tools/tool:bun=never-offered",
    "general-tools/tool:git=never-offered",
    "general-tools/tool:claude-code=never-offered",
    "general-tools/tool:codex=never-offered",
  ]);
  expect(group(groups, "general-tools").offer).toBe("list-only");
  expect(group(groups, "general-tools").level).toBe("purge");
});

test("plan: `tool:codex` (the CLI) and `hook:codex` (siltpoke's hook in it) do not share a group", () => {
  const cli = entry("tool:codex", "outside-tool", "codex");
  const { groups } = buildPlan(receipt(cli, codexHook), disk([cli.id, codexHook.id]));
  expect(shape(groups)).toEqual(["codex/hook:codex=remove", "general-tools/tool:codex=never-offered"]);
});

// Spec §8 D-A: content that names siltpoke is its own record.
const foundWiring: FoundOnDisk[] = [
  { id: "statusline:claude-code", kind: "statusline", target: "/h/.claude/settings.json" },
  { id: "statusline:antigravity", kind: "statusline", target: "/h/.gemini/antigravity/settings.json" },
  { id: "launch-agent:daemon", kind: "launch-agent", target: "/h/Library/LaunchAgents/io.siltpoke.daemon.plist" },
  { id: `file:${SHIM}`, kind: "file", target: SHIM },
  { id: "launch-agent:swiftbar", kind: "launch-agent", target: "/h/Library/LaunchAgents/io.siltpoke.swiftbar.plist" },
];
const foundUnknownOwner: FoundOnDisk[] = [
  { id: "pref:com.ameba.SwiftBar.PluginDirectory", kind: "macos-pref", target: "com.ameba.SwiftBar" },
  { id: "tool:ollama-model", kind: "outside-tool", target: "qwen2.5-coder:7b" },
];

for (const [name, r] of [
  ["no receipt", null],
  ["an unreadable receipt (readReceipt gives null for both)", null],
  ["an empty receipt", receipt()],
] as const) {
  test(`plan, ${name}: wiring that names siltpoke is offered; ownership-unknown things are list-only`, () => {
    const { groups } = buildPlan(r, disk([], [...foundWiring, ...foundUnknownOwner]));

    expect(shape(groups)).toEqual([
      "claude-code/statusline:claude-code=remove",
      "antigravity/statusline:antigravity=remove",
      "dashboard/launch-agent:daemon=remove",
      `menubar/file:${SHIM}=remove`,
      "menubar/launch-agent:swiftbar=remove",
      "menubar/pref:com.ameba.SwiftBar.PluginDirectory=unknown-owner",
      "tool:ollama-model/tool:ollama-model=unknown-owner",
    ]);
    expect(group(groups, "tool:ollama-model").offer).toBe("list-only");
    for (const g of groups) for (const i of g.items) expect(i.source).toBe("disk");
  });
}

test("plan: the receipt wins over the same thing found on disk — one item, the receipt's verdict", () => {
  const theirs = { ...pref, byUs: false };
  const { groups } = buildPlan(receipt(claudeLine, theirs), disk([claudeLine.id, theirs.id], [
    { id: claudeLine.id, kind: "statusline", target: claudeLine.target },
    { id: theirs.id, kind: "macos-pref", target: theirs.target },
  ]));
  expect(shape(groups)).toEqual([
    "claude-code/statusline:claude-code=remove",
    "menubar/pref:com.ameba.SwiftBar.PluginDirectory=kept-not-ours",
  ]);
  expect(group(groups, "claude-code").items[0]?.source).toBe("receipt");
});

test("plan: a receipt that records only some wiring still offers the rest from disk", () => {
  const { groups } = buildPlan(receipt(claudeLine), disk([claudeLine.id], foundWiring));
  expect(groups.map((g) => g.id)).toEqual(["claude-code", "antigravity", "dashboard", "menubar"]);
});

test("plan: an entry of a shape this version does not know is listed, never offered", () => {
  const odd = entry("widget:future", "file", "/h/somewhere/else");
  const { groups } = buildPlan(receipt(odd), disk([odd.id]));
  expect(shape(groups)).toEqual(["other/widget:future=never-offered"]);
  expect(group(groups, "other").offer).toBe("list-only");
});

test("plan: items carry what the executor needs — target, kind and the receipt's undo", () => {
  const withUndo = { ...codexHook, undo: { type: "remove-hook-entries", match: "/repo" } };
  const item = group(buildPlan(receipt(withUndo), disk([withUndo.id])).groups, "codex").items[0];
  expect(item).toEqual({
    id: "hook:codex",
    kind: "host-hook",
    target: "/h/.codex/hooks.json",
    byUs: true,
    source: "receipt",
    status: "remove",
    undo: { type: "remove-hook-entries", match: "/repo" },
  });
});

// Spec §3: the id is what makes a stale or invented `--remove` fail.
test("planId: the same receipt and disk give the same id, whatever order the entries are in", () => {
  const a = buildPlan(receipt(codexHook, claudeLine), disk([codexHook.id, claudeLine.id]));
  const b = buildPlan(receipt(claudeLine, codexHook), disk([claudeLine.id, codexHook.id]));
  expect(a.planId).toBe(b.planId);
  expect(a.planId).toMatch(/^[0-9a-f]{12}$/);
});

test("planId: changes when a group appears, when an item leaves the disk, and when a target moves", () => {
  const base = buildPlan(receipt(codexHook), disk([codexHook.id])).planId;
  const moreGroups = buildPlan(receipt(codexHook, claudeLine), disk([codexHook.id, claudeLine.id])).planId;
  const gone = buildPlan(receipt(codexHook), disk([])).planId;
  const moved = buildPlan(receipt({ ...codexHook, target: "/elsewhere/hooks.json" }), disk([codexHook.id])).planId;
  expect(new Set([base, moreGroups, gone, moved]).size).toBe(4);
});

test("planId: changes when ownership changes, so an old id cannot remove what is now listed as yours", () => {
  const ours = buildPlan(receipt(pref), disk([pref.id])).planId;
  const theirs = buildPlan(receipt({ ...pref, byUs: false }), disk([pref.id])).planId;
  expect(ours).not.toBe(theirs);
});

// Each of the three below holds everything else equal, so only the named field can move the id.
test("planId: two items of one group recorded in the other order give the same id", () => {
  const a = buildPlan(receipt(claudeLine, claudeHook), disk([claudeLine.id, claudeHook.id]));
  const b = buildPlan(receipt(claudeHook, claudeLine), disk([claudeLine.id, claudeHook.id]));
  expect(a.groups[0]?.items.map((i) => i.id)).not.toEqual(b.groups[0]?.items.map((i) => i.id));
  expect(a.planId).toBe(b.planId);
});

test("planId: changes when one item's verdict changes while the group is still offered", () => {
  const ours = buildPlan(receipt(shim, pref), disk([shim.id, pref.id]));
  const theirs = buildPlan(receipt(shim, { ...pref, byUs: false }), disk([shim.id, pref.id]));
  expect(group(ours.groups, "menubar").offer).toBe(group(theirs.groups, "menubar").offer);
  expect(ours.planId).not.toBe(theirs.planId);
});

test("planId: changes when a different item sits at the same target in the same group", () => {
  // The status line and the hooks live in the same settings.json.
  expect(claudeLine.target).toBe(claudeHook.target);
  const line = buildPlan(receipt(claudeLine), disk([claudeLine.id])).planId;
  const hook = buildPlan(receipt(claudeHook), disk([claudeHook.id])).planId;
  expect(line).not.toBe(hook);
});

test("plan: a running dashboard server found on disk joins the dashboard group, and the data folder is offered at purge", () => {
  const { groups } = buildPlan(null, disk([], [
    { id: "process:daemon", kind: "file", target: "/h/.siltpoke/siltpoked.pid" },
    { id: "data:home", kind: "user-data", target: "/h/.siltpoke" },
  ]));
  expect(shape(groups)).toEqual(["dashboard/process:daemon=remove", "user-data/data:home=remove"]);
  expect(groups.map((g) => g.level)).toEqual(["uninstall", "purge"]);
});

test("plan: user data is its own purge-level group, apart from every tool's wiring", () => {
  const data = entry("data:home", "user-data", "/h/.siltpoke");
  const { groups } = buildPlan(receipt(codexHook, data), disk([codexHook.id, data.id]));
  expect(shape(groups)).toEqual(["codex/hook:codex=remove", "user-data/data:home=remove"]);
  expect(group(groups, "user-data").level).toBe("purge");
});

test("plan: nothing recorded and nothing found is an empty plan with a stable id", () => {
  const a = buildPlan(null, disk([]));
  expect(a.groups).toEqual([]);
  expect(a.planId).toBe(buildPlan(receipt(), disk([])).planId);
});
