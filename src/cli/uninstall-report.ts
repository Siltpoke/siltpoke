// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { PlanGroup, PlanItem, PlanItemStatus, RemovalPlan } from "./uninstall-plan";

type After = ReadonlyMap<string, PlanItem>;

/**
 * The report at the end of an uninstall — `[61]` PR 2, plan P5.1 (spec §6, AC20).
 *
 * Pure. It is read off two plans: the one shown before anything was removed
 * and the one the disk gives afterwards. "Removed" is therefore what the disk
 * no longer shows, not what an executor said it did.
 *
 * It never says the machine is clean: what Siltpoke installed before it kept a
 * receipt is not tracked, and the report says so every time.
 */

export interface ReportInput {
  before: RemovalPlan;
  after: RemovalPlan;
  /** Groups the user said yes to in this run. */
  accepted: ReadonlySet<string>;
  /**
   * Whether this run asked the user about each offered group itself (the
   * terminal loop). Then an offered group that was not accepted is a No. One
   * `--remove` call and `--report` ask nothing, so what is left is not a choice.
   */
  asked: boolean;
  /** Whether the run was allowed to offer purge-level groups. */
  purge: boolean;
  /**
   * Items an executor finished although the disk still shows them, on purpose:
   * the data folder that keeps a trimmed receipt.json, a server told to stop.
   */
  settled: ReadonlySet<string>;
  /** When the receipt's first entry was written; null = it has no entry, or no receipt could be read. */
  receiptStart: string | null;
  /** How many project roots the receipt lists once the run is over; null = no receipt can be read. */
  receiptProjects: number | null;
  /** The plan's own wording for an item, so the report and the plan name things alike. */
  describe: (item: PlanItem) => string;
}

/** A group cut down to the items one section of the report is about. */
export interface ReportGroup {
  id: string;
  title: string;
  items: PlanItem[];
}

export interface UninstallReport {
  removed: PlanItem[];
  /** The user said yes and the item is still there. */
  notFinished: PlanItem[];
  keptByChoice: ReportGroup[];
  /** Removable, purge level, in a run without `--purge`. */
  needsPurge: ReportGroup[];
  /** Removable and nobody was asked: only when the run did not ask. */
  stillHere: ReportGroup[];
  /** Out of reach for a reason the plan knows. */
  leftInPlace: PlanItem[];
  /** Recorded, and gone before this run started (story contingency 3). */
  alreadyGone: PlanItem[];
  /**
   * False for `--report`: that call removes nothing and asks nothing, so it
   * has no "this run". What it can say is what the record shows as gone.
   */
  ranRemoval: boolean;
  /** Siltpoke-only things with no record of who installed them (spec §5). */
  unknownOwner: PlanItem[];
  receiptStart: string | null;
  receiptProjects: number | null;
  describe: (item: PlanItem) => string;
}

const WHY_LEFT: Partial<Record<PlanItemStatus, string>> = {
  "kept-not-ours": "it was there before Siltpoke",
  "never-offered": "other things may need it",
  "kept-git-tracked": "git tracks files in it, so it is part of that project",
  "kept-git-unknown": "git could not say whether it tracks this folder",
  "root-missing": "not found — the project is no longer at this path",
  "kept-in-use": "a settings file still enables it",
};

/** Items nobody could have said yes to: each goes to the list that says why. */
function sortFixed(report: UninstallReport, group: PlanGroup): void {
  for (const item of group.items) {
    if (item.status === "already-gone") report.alreadyGone.push(item);
    else if (item.status === "unknown-owner") report.unknownOwner.push(item);
    else if (item.status !== "remove") report.leftInPlace.push(item);
  }
}

/** A group the user said yes to: removed is what the disk no longer shows. */
function sortAccepted(report: UninstallReport, removable: readonly PlanItem[], after: After, settled: ReadonlySet<string>): void {
  for (const item of removable) {
    const now = after.get(item.id);
    const gone = now === undefined || now.status === "already-gone" || settled.has(item.id);
    (gone ? report.removed : report.notFinished).push(item);
  }
}

export function buildReport(input: ReportInput): UninstallReport {
  const after: After = new Map(input.after.groups.flatMap((g) => g.items).map((i) => [i.id, i] as const));
  const report: UninstallReport = {
    removed: [],
    notFinished: [],
    keptByChoice: [],
    needsPurge: [],
    stillHere: [],
    leftInPlace: [],
    alreadyGone: [],
    unknownOwner: [],
    ranRemoval: input.asked || input.accepted.size > 0,
    receiptStart: input.receiptStart,
    receiptProjects: input.receiptProjects,
    describe: input.describe,
  };

  for (const group of input.before.groups) {
    sortFixed(report, group);
    const removable = group.items.filter((i) => i.status === "remove");
    if (removable.length === 0) continue;
    if (input.accepted.has(group.id)) {
      sortAccepted(report, removable, after, input.settled);
      continue;
    }
    const left: ReportGroup = { id: group.id, title: group.title, items: removable };
    if (group.level === "purge" && !input.purge) report.needsPurge.push(left);
    else if (input.asked) report.keptByChoice.push(left);
    else report.stillHere.push(left);
  }
  return report;
}

/** Never offered, and not plan items: said once in every report (AC17: one line, no command). */
const GENERAL_TOOLS_LINE = "bun, git and the claude CLI — Siltpoke needs them, and other tools may too";
const PLUGIN_CACHE_LINE =
  "the plugin's own files under ~/.claude/plugins/cache — Claude Code clears those on its own schedule; once the plugin is uninstalled they are safe to delete by hand";

/** After the plugin itself is uninstalled: the purge front end (spec §3). */
const PURGE_COMMAND = "sh ~/.siltpoke/bin/uninstall.sh --purge";

/** More items than this in one group are counted on one line instead of listed. */
const MANY = 5;

const plural = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

function itemLines(r: UninstallReport, items: readonly PlanItem[]): string[] {
  return items.map((i) => `  - ${r.describe(i)}`);
}

function groupLines(r: UninstallReport, groups: readonly ReportGroup[]): string[] {
  return groups.flatMap((g) =>
    g.items.length > MANY
      ? [`  [${g.id}] ${g.title} — ${plural(g.items.length)}`]
      : [`  [${g.id}] ${g.title}`, ...g.items.map((i) => `    - ${r.describe(i)}`)],
  );
}

/**
 * The first line. A call that removed nothing itself (`--report`) counts what
 * the record shows as gone — whichever earlier call, or hand, removed it. It
 * does not say "Removed: 0": after a run of `--remove` calls that would deny
 * what the user has just done (review round 1, F2).
 */
function headline(r: UninstallReport): string {
  if (r.ranRemoval) return removedLine(r);
  return `Recorded items no longer on this machine: ${r.alreadyGone.length}`;
}

function removedLine(r: UninstallReport): string {
  const recorded = r.removed.filter((i) => i.source === "receipt").length;
  const found = r.removed.length - recorded;
  if (r.removed.length === 0) return "Removed: 0 items";
  const parts = [
    ...(recorded > 0 ? [`${recorded} recorded in the install receipt`] : []),
    ...(found > 0 ? [`${found} found on disk with no record`] : []),
  ];
  return `Removed: ${plural(r.removed.length)} (${parts.join(", ")})`;
}

function notTracked(r: UninstallReport): string[] {
  const lines = ["", "Not tracked:"];
  if (r.receiptStart === null) {
    // A receipt with no entry is not "no receipt": after a purge that kept a project folder it is on the screen two lines up.
    const projects = r.receiptProjects === 1 ? "1 project folder" : `${r.receiptProjects} project folders`;
    const first =
      r.receiptProjects === null
        ? "There is no install receipt on this machine, so nothing Siltpoke installed was recorded."
        : r.receiptProjects === 0
          ? "The install receipt on this machine is empty, so nothing Siltpoke installed was recorded."
          : `The install receipt on this machine lists ${projects} Siltpoke wrote into, and nothing it installed.`;
    lines.push(`  ${first}`, "  This report covers only what could be recognised on disk.");
  } else {
    lines.push(
      `  Siltpoke started recording what it installs on ${r.receiptStart.slice(0, 10)}.`,
      "  Anything it installed before that is not tracked, so this report cannot say whether it is still here.",
    );
  }
  if (r.unknownOwner.length > 0) {
    lines.push("", "  Found on this machine, and Siltpoke cannot tell who installed them:", ...itemLines(r, r.unknownOwner));
  }
  return lines;
}

/**
 * After one `--remove` call: what that call did and how much is left. The
 * caller asks one group at a time, so the whole report after each call would
 * repeat itself; `uninstall --report` prints it once at the end.
 */
export function renderCallReport(r: UninstallReport): string {
  const lines = [removedLine(r)];
  if (r.notFinished.length > 0) lines.push("Not removed — still there:", ...itemLines(r, r.notFinished));
  const left = [...r.stillHere, ...r.needsPurge, ...r.keptByChoice].reduce((n, g) => n + g.items.length, 0);
  lines.push(
    left > 0
      ? `Still on this machine and removable: ${plural(left)}. \`uninstall --report\` lists them and what is not tracked.`
      : "Nothing else here is Siltpoke's to remove. `uninstall --report` says what is left in place and what is not tracked.",
  );
  return `${lines.join("\n")}\n`;
}

export function renderReport(r: UninstallReport): string {
  const lines = ["", "Siltpoke uninstall — report", "", headline(r)];
  if (r.removed.length > 0 && r.removed.length <= MANY) lines.push(...itemLines(r, r.removed));
  if (!r.ranRemoval) {
    if (r.alreadyGone.length <= MANY) lines.push(...itemLines(r, r.alreadyGone));
    lines.push("  (Removed by an earlier call, or by hand. Something that was never recorded is not counted once it is gone.)");
  }

  const section = (title: string, body: string[]) => {
    if (body.length > 0) lines.push("", title, ...body);
  };
  section("Not removed — you said yes, and these are still there:", itemLines(r, r.notFinished));
  section("Kept by your choice:", groupLines(r, r.keptByChoice));
  section(
    `Not asked — these are only offered with --purge (uninstall the plugin first, then: ${PURGE_COMMAND}):`,
    groupLines(r, r.needsPurge),
  );
  section("Still on this machine — Siltpoke can remove these:", groupLines(r, r.stillHere));
  // A general tool the receipt names has its own line; the sentence covers the ones it does not.
  const namesGeneralTool = r.leftInPlace.some((i) => i.status === "never-offered" && i.kind === "outside-tool");
  section("Left in place — not Siltpoke's to remove:", [
    ...r.leftInPlace.map((i) => `  - ${r.describe(i)}: ${WHY_LEFT[i.status] ?? i.status}${i.note ? ` (${i.note})` : ""}`),
    ...(namesGeneralTool ? [] : [`  - ${GENERAL_TOOLS_LINE}`]),
    `  - ${PLUGIN_CACHE_LINE}`,
  ]);
  if (r.ranRemoval) section("Already gone before this run — recorded, and no longer on this machine:", itemLines(r, r.alreadyGone));
  lines.push(...notTracked(r));

  const somethingLeft =
    r.notFinished.length + r.keptByChoice.length + r.needsPurge.length + r.stillHere.length + r.leftInPlace.length + r.unknownOwner.length > 0;
  if (!somethingLeft) {
    lines.push(
      "",
      "Nothing that this version of Siltpoke can recognise is left on this machine.",
      "That is not the same as nothing being left: see \"Not tracked\" above.",
    );
  }
  lines.push("");
  return lines.join("\n");
}
