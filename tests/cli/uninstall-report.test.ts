// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import type { PlanGroup, PlanItem, PlanItemStatus, RemovalPlan } from "../../src/cli/uninstall-plan";
import { buildReport, type ReportInput, renderReport } from "../../src/cli/uninstall-report";

// `[61]` PR 2, plan P5.1 (spec §6, AC20): the report at the end of an uninstall
// is read off two plans — the one shown before anything was removed and the
// one the disk gives afterwards. It is pure: no file is read here.

function item(id: string, status: PlanItemStatus = "remove", over: Partial<PlanItem> = {}): PlanItem {
  return { id, kind: "file", target: `/t/${id}`, byUs: true, source: "receipt", status, undo: {}, ...over };
}

function group(id: string, items: PlanItem[], level: "uninstall" | "purge" = "uninstall"): PlanGroup {
  return {
    id,
    title: `Title of ${id}`,
    level,
    offer: items.some((i) => i.status === "remove") ? "remove" : "list-only",
    items,
  };
}

const plan = (...groups: PlanGroup[]): RemovalPlan => ({ planId: "0".repeat(12), groups });

function input(over: Partial<ReportInput>): ReportInput {
  return {
    before: plan(),
    after: plan(),
    accepted: new Set(),
    asked: true,
    purge: false,
    settled: new Set(),
    receiptStart: "2026-10-03T08:00:00.000Z",
    receiptProjects: 0,
    describe: (i) => `<${i.id}>`,
    ...over,
  };
}

const text = (over: Partial<ReportInput>) => renderReport(buildReport(input(over)));

describe("what counts as removed", () => {
  test("an item the user said yes to that the disk no longer shows is removed, and counted by where it was known from", () => {
    const before = plan(group("codex", [item("hook:codex"), item("file:/x/a.md", "remove", { source: "disk", byUs: null })]));
    const r = buildReport(input({ before, after: plan(), accepted: new Set(["codex"]) }));
    expect(r.removed.map((i) => i.id)).toEqual(["hook:codex", "file:/x/a.md"]);
    const out = renderReport(r);
    expect(out).toContain("Removed: 2 items (1 recorded in the install receipt, 1 found on disk with no record)");
  });

  test("a recorded item that turns 'already gone' after a yes is removed, not 'already gone before this run'", () => {
    const before = plan(group("codex", [item("hook:codex")]));
    const after = plan(group("codex", [item("hook:codex", "already-gone")]));
    const r = buildReport(input({ before, after, accepted: new Set(["codex"]) }));
    expect(r.removed.map((i) => i.id)).toEqual(["hook:codex"]);
    expect(r.alreadyGone).toEqual([]);
  });

  test("a yes whose item is still there afterwards is 'could not finish' — a yes is not a removal", () => {
    const before = plan(group("codex", [item("hook:codex")]));
    const r = buildReport(input({ before, after: before, accepted: new Set(["codex"]) }));
    expect(r.removed).toEqual([]);
    expect(r.notFinished.map((i) => i.id)).toEqual(["hook:codex"]);
    const out = renderReport(r);
    expect(out).toContain("Removed: 0 items");
    expect(out).toMatch(/Not removed — you said yes[^\n]*:\n {2}- <hook:codex>/);
  });

  test("an item the executor settled on purpose is removed even though the disk still shows it", () => {
    // The data folder keeps a trimmed receipt.json; a server told to stop keeps its pidfile for a moment.
    const before = plan(group("user-data", [item("data:home", "remove", { kind: "user-data", source: "disk" })], "purge"));
    const r = buildReport(input({ before, after: before, accepted: new Set(["user-data"]), purge: true, settled: new Set(["data:home"]) }));
    expect(r.removed.map((i) => i.id)).toEqual(["data:home"]);
    expect(r.notFinished).toEqual([]);
  });

  test("nothing in a group the user did not say yes to is ever counted as removed, whatever the disk says afterwards", () => {
    const before = plan(group("codex", [item("hook:codex")]));
    const r = buildReport(input({ before, after: plan(), accepted: new Set() }));
    expect(r.removed).toEqual([]);
  });
});

describe("what was kept, and why", () => {
  test("a group answered No is listed under 'Kept by your choice' with its items", () => {
    const before = plan(group("codex", [item("hook:codex")]), group("qoder", [item("hook:qoder")]));
    const after = plan(group("codex", [item("hook:codex")]));
    const out = text({ before, after, accepted: new Set(["qoder"]) });
    expect(out).toMatch(/Kept by your choice:\n {2}\[codex\] Title of codex\n {4}- <hook:codex>/);
    expect(out).not.toMatch(/Kept by your choice:[\s\S]*<hook:qoder>/);
  });

  test("a purge-level group in a run without --purge is 'not asked', and the line says what asks for it", () => {
    const before = plan(group("user-data", [item("data:home", "remove", { kind: "user-data" })], "purge"));
    const r = buildReport(input({ before, after: before }));
    expect(r.keptByChoice).toEqual([]);
    expect(r.needsPurge.map((g) => g.id)).toEqual(["user-data"]);
    const out = renderReport(r);
    expect(out).toMatch(/Not asked[^\n]*--purge[^\n]*:\n {2}\[user-data\]/);
    // The one place a default-level run says how the data is deleted, and in which order.
    expect(out).toMatch(/uninstall the plugin first, then: sh ~\/\.siltpoke\/bin\/uninstall\.sh --purge/);
  });

  test("with no questions asked in this run (one --remove call), what is left is 'still on this machine', never 'your choice'", () => {
    const before = plan(group("codex", [item("hook:codex")]), group("qoder", [item("hook:qoder")]));
    const after = plan(group("codex", [item("hook:codex")]));
    const out = text({ before, after, accepted: new Set(["qoder"]), asked: false });
    expect(out).not.toContain("Kept by your choice");
    expect(out).toMatch(/Still on this machine[^\n]*:\n {2}\[codex\] Title of codex/);
  });

  test("items Siltpoke will not remove are listed with the reason each one carries", () => {
    const before = plan(
      group("project-data", [
        item("data:project:/p/a", "kept-git-tracked"),
        item("data:project:/p/b", "root-missing", { note: "moved" }),
      ], "purge"),
      group("general-tools", [item("tool:bun", "never-offered", { kind: "outside-tool" })], "purge"),
      group("menubar", [item("pref:PluginDirectory", "kept-not-ours", { byUs: false })]),
    );
    const out = text({ before, after: before });
    expect(out).toContain("Left in place — not Siltpoke's to remove:");
    expect(out).toContain("- <data:project:/p/a>: git tracks files in it, so it is part of that project");
    expect(out).toContain("- <data:project:/p/b>: not found — the project is no longer at this path (moved)");
    expect(out).toContain("- <tool:bun>: other things may need it");
    expect(out).toContain("- <pref:PluginDirectory>: it was there before Siltpoke");
  });

  test("general tools and the plugin's own cache are named in every report, with no command to remove them (AC17)", () => {
    const out = text({});
    expect(out).toContain("- bun, git and the claude CLI — Siltpoke needs them, and other tools may too");
    expect(out).toContain("~/.claude/plugins/cache");
    expect(out).not.toMatch(/rm -rf|brew uninstall|bun upgrade/);
  });

  test("a general tool the receipt names gets its own line, and the general sentence is not repeated", () => {
    const tools = plan(group("general-tools", [item("tool:bun", "never-offered", { kind: "outside-tool" })], "purge"));
    const out = text({ before: tools, after: tools });
    expect(out).toContain("- <tool:bun>: other things may need it");
    expect(out).not.toContain("bun, git and the claude CLI");
  });

  test("a call that removed nothing and asked nothing counts what the record shows as gone, under no 'this run' wording", () => {
    const gone = plan(group("codex", [item("hook:codex", "already-gone")]));
    const out = text({ before: gone, after: gone, asked: false });
    expect(out).toContain("Recorded items no longer on this machine: 1\n  - <hook:codex>");
    expect(out).not.toMatch(/Removed: |before this run/);
  });

  test("a recorded item that was gone before the run is 'already gone', and is not an error", () => {
    const before = plan(group("codex", [item("hook:codex", "already-gone")]));
    const r = buildReport(input({ before, after: before }));
    expect(r.alreadyGone.map((i) => i.id)).toEqual(["hook:codex"]);
    expect(renderReport(r)).toMatch(/Already gone before this run[^\n]*:\n {2}- <hook:codex>/);
  });

  test("more than five items of one group are counted on one line instead of listed", () => {
    const copies = Array.from({ length: 6 }, (_, n) => item(`backup:/h/settings.json.pre-siltpoke-${n}`));
    const before = plan(group("settings-backups", copies, "purge"));
    const out = text({ before, after: before, purge: true });
    expect(out).toMatch(/\[settings-backups\] Title of settings-backups — 6 items\n/);
    expect(out).not.toContain("<backup:");
  });
});

describe("what the report cannot know — said, never left out (AC20)", () => {
  test("with a receipt: the date recording started, and that anything earlier is not tracked", () => {
    const out = text({});
    expect(out).toContain("Not tracked:");
    expect(out).toContain("started recording what it installs on 2026-10-03");
    expect(out).toContain("before that is not tracked");
  });

  test("without a receipt it says nothing was recorded, and gives no date", () => {
    const out = text({ receiptStart: null, receiptProjects: null });
    expect(out).toContain("There is no install receipt on this machine");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test.each([
    [1, "The install receipt on this machine lists 1 project folder Siltpoke wrote into, and nothing it installed."],
    [3, "The install receipt on this machine lists 3 project folders Siltpoke wrote into, and nothing it installed."],
    [0, "The install receipt on this machine is empty, so nothing Siltpoke installed was recorded."],
  ])("a receipt with no entry and %i project(s) is not called 'no receipt'", (receiptProjects, sentence) => {
    const out = text({ receiptStart: null, receiptProjects });
    expect(out).toContain(`Not tracked:\n  ${sentence}\n  This report covers only what could be recognised on disk.`);
    expect(out).not.toContain("There is no install receipt");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("a receipt with an entry gives the date whatever it lists as projects", () => {
    const out = text({ receiptProjects: 2 });
    expect(out).toContain("started recording what it installs on 2026-10-03");
    expect(out).not.toContain("install receipt on this machine");
  });

  test("a Siltpoke-only tool with no record is listed there, with the text that carries its remove command", () => {
    const tool = item("tool:swiftbar", "unknown-owner", { kind: "outside-tool", source: "disk", byUs: null });
    const before = plan(group("tool:swiftbar", [tool], "purge"));
    const out = text({ before, after: before, describe: () => "SwiftBar (to remove it yourself: brew uninstall --cask swiftbar)" });
    expect(out).toMatch(/Not tracked:[\s\S]*Siltpoke cannot tell who installed[^\n]*:\n {2}- SwiftBar \(to remove it yourself: brew uninstall --cask swiftbar\)/);
    // It is not also listed as something left in place for a reason Siltpoke knows.
    expect(out).not.toMatch(/Left in place[\s\S]*SwiftBar[\s\S]*Not tracked:/);
  });

  test.each([
    ["everything removed", { before: plan(group("codex", [item("hook:codex")])), after: plan(), accepted: new Set(["codex"]) }],
    ["nothing found at all", {}],
    ["no receipt, nothing found", { receiptStart: null, receiptProjects: null }],
  ] as [string, Partial<ReportInput>][])("%s: the word 'clean' is never used, and the not-tracked section is always there", (_name, over) => {
    const out = text(over);
    expect(out).not.toMatch(/clean/i);
    expect(out).toContain("Not tracked:");
  });

  test("when nothing recognisable is left, the closing line says that is not the same as nothing being left", () => {
    const out = text({ before: plan(group("codex", [item("hook:codex")])), after: plan(), accepted: new Set(["codex"]) });
    expect(out).toContain("Nothing that this version of Siltpoke can recognise is left on this machine.");
    expect(out).toContain("That is not the same as nothing being left");
  });

  test("the closing line is absent while something recognisable is still there", () => {
    const before = plan(group("codex", [item("hook:codex")]));
    for (const out of [
      text({ before, after: before }),
      text({ before, after: before, accepted: new Set(["codex"]) }),
      text({ before: plan(group("g", [item("tool:bun", "never-offered")])), after: plan(group("g", [item("tool:bun", "never-offered")])) }),
    ]) {
      expect(out).not.toContain("can recognise is left");
    }
  });
});
