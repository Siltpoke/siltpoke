// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { dirname } from "node:path";
import { hostsWithPlugin } from "../installer/plugin-hosts";
import { siltpokeRoot } from "../installer/paths";
import { sweepCreated } from "../installer/created-sweep";
import { mergeBootstrapFragment, readReceipt } from "../installer/receipt";
import { isOurStatusLine } from "../installer/statusline-restore";
import {
  type MenubarTargets,
  type PluginUninstallReport,
  runPluginUninstall,
  type UninstallEffects,
  type UninstallStep,
} from "./plugin-uninstall";
import { type DiskProbes, isSourceWrapper, readDisk } from "./uninstall-disk";
import { buildPlan, type PlanGroup, type PlanItem, type PlanItemStatus, type RemovalPlan } from "./uninstall-plan";
import { deleteDataFolder, describeTool, type PurgeEffects, purgeItem, receiptToKeep } from "./uninstall-purge";
import { buildReport, renderCallReport, renderReport, type UninstallReport } from "./uninstall-report";
import { shimMatchesReceipt, type UndoEffects, undoItem } from "./uninstall-undo";

/**
 * `siltpoke-cli uninstall …` — `[61]` PR 2, plan P2.2 / P2.2b (spec §3).
 *
 * One removal plan, shown before anything is removed. The CLI removes only
 * groups that are in the plan it would show right now (`--plan-id`), one group
 * per call; several groups in one run only through its own y/N loop, which
 * needs a terminal. What this cannot enforce is stated in the spec, not here.
 *
 * Exit codes: 0 done · 1 something could not be finished · 2 the request was
 * refused (nothing changed) · 3 nothing was asked for and there is no terminal
 * to ask in (nothing changed).
 */

export interface UninstallRunDeps {
  effects: UninstallEffects;
  probes: DiskProbes;
  /** What the default level's own executors need from outside the filesystem. */
  undo: UndoEffects;
  /** The purge level's commands that change the machine (`ollama rm`, …). */
  purge: PurgeEffects;
  isTTY: boolean;
  /** One y/N question, default No. Called only when `isTTY`. */
  ask: (question: string) => Promise<boolean>;
  write: (text: string) => void;
}

interface Request {
  plan: boolean;
  report: boolean;
  json: boolean;
  purge: boolean;
  planId: string | null;
  removes: string[];
}

/** The request, or the reason it is not one. */
function parse(args: readonly string[]): Request | string {
  const req: Request = { plan: false, report: false, json: false, purge: false, planId: null, removes: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--plan") req.plan = true;
    else if (arg === "--report") req.report = true;
    else if (arg === "--json") req.json = true;
    else if (arg === "--purge") req.purge = true;
    else if (arg === "--plan-id" || arg === "--remove") {
      const value = args[++i];
      if (value === undefined) return `${arg} needs a value`;
      if (arg === "--plan-id") req.planId = value;
      else req.removes.push(value);
    } else return `unknown option: ${arg}`;
  }
  if (req.report && (req.plan || req.planId !== null || req.removes.length > 0)) {
    return "--report only prints: it takes no --plan, --plan-id or --remove";
  }
  if (req.removes.length > 1) {
    return "one group per call: run --remove once for each group, after the user said yes to that group";
  }
  return req;
}

const STATUS_TEXT: Record<PlanItemStatus, string> = {
  remove: "will be removed",
  "kept-not-ours": "kept — it was there before Siltpoke",
  "unknown-owner": "kept — Siltpoke cannot tell who installed this",
  "never-offered": "kept — other things may need it",
  "already-gone": "already gone",
  "kept-git-tracked": "kept — git tracks files in it, so it is part of that project",
  "kept-git-unknown": "kept — git could not say whether it tracks this folder",
  "root-missing": "not found — the project is no longer at this path",
  "kept-in-use": "kept — a settings file still enables it",
};

/**
 * What the item IS, not just where it lives: "will be removed: settings.json"
 * would read as the whole file going, when only siltpoke's part of it does.
 */
function describe(i: PlanItem): string {
  if (i.id.startsWith("statusline:")) return `Siltpoke's status line in ${i.target} (the rest of the file stays)`;
  if (i.id.startsWith("hook:")) return `Siltpoke's hooks in ${i.target} (the rest of the file stays)`;
  if (i.id === "process:daemon") return "the running dashboard server (it is stopped)";
  if (i.id === "launch-agent:daemon") return `the dashboard's start-at-login entry ${i.target}`;
  if (i.id === "launch-agent:swiftbar") return `the login item that opens SwiftBar ${i.target}`;
  if (i.id.startsWith("file:") && !i.target.endsWith(".md")) return `the pet's SwiftBar plugin script ${i.target}`;
  if (i.id.startsWith("file:")) return `the slash-command file ${i.target}`;
  if (i.id.startsWith("pref:")) return `the macOS setting ${i.id.slice("pref:".length)}`;
  if (i.id === "data:home") return `your Siltpoke data folder ${i.target}`;
  if (i.id.startsWith("data:project:")) return `Siltpoke's review data for this project: ${i.target}`;
  if (i.id.startsWith("backup:")) return `the settings copy ${i.target}`;
  if (i.kind === "outside-tool") return describeTool(i);
  return i.target;
}

function renderGroup(g: PlanGroup, purge: boolean): string[] {
  const note = g.offer === "list-only" ? "  (listed only)" : g.level === "purge" && !purge ? "  (only with --purge)" : "";
  const lines = g.items.map((i) => `    ${STATUS_TEXT[i.status]}: ${describe(i)}${i.note ? ` (${i.note})` : ""}`);
  // Every setup run leaves one copy: a real home had 391 of them (read-only run, 2026-10-07).
  const copies = g.id === "settings-backups" && g.items.length > MANY_COPIES && g.items.every((i) => i.status === "remove");
  return [
    `[${g.id}] ${g.title}${note}`,
    ...(copies
      ? [`    will be removed: ${g.items.length} files in ${dirname(g.items[0]?.target ?? "")} — every one whose name starts with settings.json.pre-siltpoke`]
      : lines),
  ];
}

/** More settings copies than this are counted on one line instead of listed. */
const MANY_COPIES = 5;

/**
 * Why nothing of the purge level may be removed right now, or null. While a
 * host still has the plugin, none of it goes — the data folder for the reason
 * PR 1 gives, the rest because the maintainer chose one rule over two (2026-10-07):
 * "the plugin is still installed" means the uninstall is not at this step yet.
 * `~/.siltpoke` keeps its own copy of this gate (plugin-uninstall.ts).
 */
function purgeGate(env: NodeJS.ProcessEnv, deps: UninstallRunDeps): string | null {
  const { hosts, known } = hostsWithPlugin(env, deps.effects.codexListsPlugin);
  if (hosts.length > 0) {
    return `the Siltpoke plugin is still installed in ${hosts.join(", ")}. Uninstall the plugin there first, then run this again.`;
  }
  return known ? null : "Siltpoke could not tell whether its plugin is still installed, so nothing of this level is removed.";
}

/**
 * Why the data folder was not deleted, as the line under its group — the same
 * form `purgeGate` gives the other purge groups. What to do about it is in the
 * numbered steps printed after it.
 */
function dataRefusal(r: PluginUninstallReport): string | null {
  if (r.purgeRefused === "plugin-installed") return `the Siltpoke plugin is still installed in ${r.hosts.join(", ")}.`;
  if (r.purgeRefused === "unknown-install-state") return "Siltpoke could not tell whether its plugin is still installed.";
  if (r.purgeRefused !== "status-line-not-restored") return null;
  // A settings.json that cannot be parsed is refused too, and nothing was seen pointing anywhere.
  return r.settingsReadable
    ? "Claude Code's settings still point into this folder."
    : "Claude Code's settings.json cannot be read, so Siltpoke cannot tell whether it still needs this folder.";
}

function renderPlan(plan: RemovalPlan, purge: boolean): string {
  if (plan.groups.length === 0) return `Siltpoke uninstall — nothing of Siltpoke's was found (plan ${plan.planId})\n`;
  const lines = [`Siltpoke uninstall — what is on this machine (plan ${plan.planId})`, ""];
  for (const g of plan.groups) lines.push(...renderGroup(g, purge), "");
  return `${lines.join("\n")}`;
}

/** Which of PR 1's steps takes an item back; undefined = a per-item executor does (uninstall-undo.ts). */
function stepFor(group: PlanGroup, item: PlanItem): UninstallStep | "data" | undefined {
  if (item.id === "statusline:claude-code") return "status-line";
  if (item.id === "statusline:antigravity") return "agy-status-line";
  if (item.id === "launch-agent:daemon" || item.id === "process:daemon") return "dashboard";
  if (item.id === "launch-agent:swiftbar") return "menubar";
  if (group.id === "menubar" && item.kind === "file") return "menubar";
  if (item.id === "data:home") return "data";
  return undefined;
}

/**
 * Remove one group's removable items. True when everything asked for was done.
 * `settled` gains the items that are finished although the disk still shows
 * them: the report would otherwise list them as not removed.
 */
async function removeGroup(
  group: PlanGroup,
  env: NodeJS.ProcessEnv,
  deps: UninstallRunDeps,
  settled: Set<string>,
  // The terminal loop has just printed the group above its question.
  header = true,
): Promise<boolean> {
  const asked = group.items.filter((i) => i.status === "remove");
  // A recorded shim whose bytes changed since is the user's now: the menu-bar
  // step never hears of it (plan P3.4; Siltpoke review c-bf8d).
  const changedShims = asked.filter((i) => i.kind === "file" && stepFor(group, i) === "menubar" && !shimMatchesReceipt(i));
  const removable = asked.filter((i) => !changedShims.includes(i));
  const steps = new Set<UninstallStep>();
  let data = false;
  const perItem: PlanItem[] = [];
  for (const item of removable) {
    const step = stepFor(group, item);
    if (step === undefined) perItem.push(item);
    else if (step === "data") data = true;
    else steps.add(step);
  }

  let ok = changedShims.length === 0;
  if (header) deps.write(`[${group.id}] ${group.title}\n`);
  if (group.level === "purge" && !data) {
    const refused = purgeGate(env, deps);
    if (refused !== null) {
      deps.write(`  ! not removed — ${refused}\n`);
      return false;
    }
  }
  // `[80]`: the data step deletes the receipt (or cuts it down), so empty shells go first.
  if (data) for (const path of sweepCreated(env)) deps.write(`  - removed ${path}: Siltpoke created it and nothing else is in it\n`);
  // Decided before anything of this group is deleted: what the receipt must still say afterwards.
  const keep = data ? receiptToKeep(readReceipt(env), currentPlan(env, deps)) : null;
  for (const item of changedShims) {
    deps.write(`  ! could not finish — menu bar: ${item.target} is no longer the file Siltpoke wrote — left as it is.\n`);
  }
  if (steps.size > 0 || data) {
    // The menu-bar step gets the plan's own items, so it can remove nothing the
    // plan did not list as removable (review round 1, I2).
    const menubar: MenubarTargets = {
      shims: removable.filter((i) => i.kind === "file" && stepFor(group, i) === "menubar").map((i) => i.target),
      loginItem: removable.some((i) => i.id === "launch-agent:swiftbar"),
    };
    // A receipt entry is what makes the source wrapper ours; found on disk alone it is not.
    const recorded = removable.some((i) => i.id === "statusline:claude-code" && i.source === "receipt");
    const result = await runPluginUninstall(
      env,
      {
        steps,
        purge: data,
        menubar,
        deleteData: () => deleteDataFolder(env, keep),
        receiptKept: keep?.entries.length ?? 0,
        projectsKept: keep?.projects.length ?? 0,
        ...(recorded ? { statusLineIsOurs: (c: unknown) => isOurStatusLine(c) || isSourceWrapper(c) } : {}),
      },
      deps.effects,
    );
    for (const d of result.done) deps.write(`  - ${d}\n`);
    const refused = dataRefusal(result.report);
    if (refused !== null) deps.write(`  ! not removed — ${refused}\n`);
    for (const e of result.errors) deps.write(`  ! could not finish — ${e}\n`);
    // Only a run that changed nothing AND was neither refused nor failed found nothing to change.
    if (result.done.length === 0 && refused === null && result.errors.length === 0) deps.write("  - nothing needed changing\n");
    // The data folder has its own gates, and a refusal says what to do first.
    if (result.next.length > 0) deps.write("  Still to do:\n");
    for (const [i, n] of result.next.entries()) deps.write(`    ${i + 1}. ${n}\n`);
    ok = ok && result.exitCode === 0;
    // With a receipt kept the folder is still there, holding that one file — and
    // only that: anything else in it was written back after the delete.
    const inData = deps.probes.namesIn(siltpokeRoot(env));
    if (result.report.purged && inData.every((name) => name === "receipt.json")) settled.add("data:home");
    // A server told to stop leaves its pidfile for a moment. "not-running" is
    // not settled: it also means "something answered and it was not safe to
    // stop it", so the disk decides (review round 1, F1).
    if (result.report.daemon === "stopping") settled.add("process:daemon");
  }
  for (const item of perItem) {
    const result = undoItem(item, deps.undo) ?? purgeItem(item, env, deps.probes, deps.purge);
    if (result === null) deps.write(`  ! not removed — this version cannot undo it yet: ${item.id} (${item.target})\n`);
    else if (result.outcome === "done") deps.write(`  - ${result.line}\n`);
    else if (result.outcome === "not-done") deps.write(`  ! could not finish — ${result.line}\n`);
    ok = ok && result !== null && result.outcome !== "not-done";
  }
  // `[80]`: whatever the install created and this group's removal has now left empty.
  for (const path of sweepCreated(env)) deps.write(`  - removed ${path}: Siltpoke created it and nothing else is in it\n`);
  return ok;
}

function currentPlan(env: NodeJS.ProcessEnv, deps: UninstallRunDeps): RemovalPlan {
  const receipt = readReceipt(env);
  return buildPlan(receipt, readDisk(receipt, env, deps.probes));
}

/** When the receipt's first entry was written, or null. Read before a removal: a purge may delete the receipt. */
function receiptStart(env: NodeJS.ProcessEnv): string | null {
  const times = (readReceipt(env)?.entries ?? []).map((e) => e.at).sort();
  return times[0] ?? null;
}

interface RunSoFar {
  before: RemovalPlan;
  accepted: ReadonlySet<string>;
  /** Whether this run asked about each offered group itself. */
  asked: boolean;
  purge: boolean;
  settled: ReadonlySet<string>;
  receiptStart: string | null;
}

/** The report for this run, read off the plan before it and the disk now (spec §6). */
function reportOf(run: RunSoFar, env: NodeJS.ProcessEnv, deps: UninstallRunDeps): UninstallReport {
  // The receipt as it is NOW: a purge can delete it, trim it, or write the first one (review round 1).
  const receiptProjects = readReceipt(env)?.projects.length ?? null;
  // The date from before the run when there was one — a purge may delete the entries. With none
  // before, read again: this run may have written the first entry, the bootstrap note about bun (round 2).
  const start = run.receiptStart ?? receiptStart(env);
  return buildReport({ ...run, after: currentPlan(env, deps), receiptStart: start, receiptProjects, describe });
}

export async function runUninstallCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: UninstallRunDeps,
): Promise<number> {
  const req = parse(args);
  if (typeof req === "string") {
    deps.write(`Siltpoke uninstall: ${req}\nNothing was removed.\n`);
    return 2;
  }
  const plan = currentPlan(env, deps);

  if (req.plan) {
    deps.write(req.json ? `${JSON.stringify(plan)}\n` : renderPlan(plan, req.purge));
    return 0;
  }
  const started = receiptStart(env);
  if (req.report) {
    // Changes nothing. With nothing removed in this call, it says what is on the machine now.
    const now: RunSoFar = { before: plan, accepted: new Set(), asked: false, purge: req.purge, settled: new Set(), receiptStart: started };
    deps.write(renderReport(reportOf(now, env, deps)));
    return 0;
  }

  const target = req.removes[0];
  if (target !== undefined) {
    const refusal = refuse(plan, req, target);
    if (refusal !== null) {
      deps.write(`Siltpoke uninstall: ${refusal}\nNothing was removed.\n`);
      return 2;
    }
    const group = plan.groups.find((g) => g.id === target) as PlanGroup;
    // After the id check: the note adds a receipt entry, which would move the id.
    mergeBootstrapFragment(env);
    const settled = new Set<string>();
    const ok = await removeGroup(group, env, deps, settled);
    const call: RunSoFar = { before: plan, accepted: new Set([target]), asked: false, purge: req.purge, settled, receiptStart: started };
    deps.write(renderCallReport(reportOf(call, env, deps)));
    // Last, and alone on its line: the next `--remove` needs this id.
    deps.write(`plan is now ${currentPlan(env, deps).planId}\n`);
    return ok ? 0 : 1;
  }

  const offered = plan.groups.filter((g) => g.offer === "remove" && (g.level === "uninstall" || req.purge));
  if (!deps.isTTY) {
    deps.write(renderPlan(plan, req.purge));
    deps.write(
      "Nothing was removed: there is no terminal to ask in. Remove one group at a time with\n" +
        `  uninstall --plan-id ${plan.planId} --remove <group>\n`,
    );
    return 3;
  }

  let allOk = true;
  const accepted = new Set<string>();
  const settled = new Set<string>();
  for (const g of offered) {
    deps.write(`\n${renderGroup(g, req.purge).join("\n")}\n`);
    if (await deps.ask(`Remove ${g.title}?`)) {
      // Only once something is in fact being removed: a run of all-No changes nothing.
      mergeBootstrapFragment(env);
      accepted.add(g.id);
      allOk = (await removeGroup(g, env, deps, settled, false)) && allOk;
    } else deps.write("  kept\n");
  }
  // Everything that was not asked about is in the report, with the reason.
  const loop: RunSoFar = { before: plan, accepted, asked: true, purge: req.purge, settled, receiptStart: started };
  deps.write(renderReport(reportOf(loop, env, deps)));
  return allOk ? 0 : 1;
}

/** Why `--remove <target>` is not allowed against this plan, or null. */
function refuse(plan: RemovalPlan, req: Request, target: string): string | null {
  if (req.planId === null) return "--remove needs --plan-id (run `uninstall --plan` first)";
  if (req.planId !== plan.planId) {
    return `plan ${req.planId} is not the current plan (${plan.planId}) — something changed; run \`uninstall --plan\` again and show it`;
  }
  const group = plan.groups.find((g) => g.id === target);
  if (!group) return `"${target}" is not a group in the plan`;
  if (group.offer !== "remove") return `"${target}" is listed only — nothing in it is Siltpoke's to remove`;
  if (group.level === "purge" && !req.purge) return `"${target}" deletes data or an outside tool — it needs --purge on the same call`;
  return null;
}
