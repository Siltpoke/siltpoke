// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProbeExec } from "../installer/menubar-setup";
import { homeDir, settingsJsonPath, siltpokeRoot } from "../installer/paths";
import { PLC_PLUGIN } from "../installer/plc-install";
import { type Receipt, writeTrimmedReceipt } from "../installer/receipt";
import { OLLAMA_MODEL } from "../installer/setup-ollama";
import { SWIFTBAR_APP_PATH } from "../installer/swiftbar-autostart";
import type { FoundOnDisk, PlanItem, RemovalPlan, Verdict } from "./uninstall-plan";
import type { UndoResult } from "./uninstall-undo";

/**
 * The purge level — `[61]` PR 2, plan P4 (spec
 * an internal design note §4, §5).
 *
 * Three things the default level never touches: the `.siltpoke/` folder inside
 * each project, the copies of `settings.json` every setup run left, and the
 * outside tools siltpoke itself installed. `~/.siltpoke` is the fourth and goes
 * last (uninstall-run.ts), because it holds the list of projects read here.
 *
 * The first half is read-only and feeds the removal plan; the second half is
 * the executors, each of which checks again at the moment it deletes.
 */

/** The reads this file needs; `DiskProbes` (uninstall-disk.ts) is one. */
export interface PurgeProbes {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
  /** The names directly inside `dir`. Empty when `dir` is not there. */
  namesIn: (dir: string) => string[];
  exec: ProbeExec;
  /** Is this outside tool on the machine? null = the question could not be asked. */
  toolPresent: (tool: { id: string; target: string }) => boolean | null;
}

/** Commands that change the machine (`ollama rm`, `claude plugin uninstall`, `brew uninstall`). */
export interface PurgeEffects {
  run: ProbeExec;
}

const PROJECT_ID = "data:project:";
const BACKUP_ID = "backup:";
const BACKUP_NAME = "settings.json.pre-siltpoke";

function readObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every project siltpoke is known to have written into: the receipt's list and
 * the per-project memory under `~/.siltpoke/projects/` (spec §4 step 1). Both,
 * because the receipt started on 2026-10-03 and the memory folders did not.
 */
function knownProjectRoots(receipt: Receipt | null, env: NodeJS.ProcessEnv, probes: PurgeProbes): string[] {
  const roots = new Set(receipt?.projects ?? []);
  const projects = join(siltpokeRoot(env), "projects");
  for (const id of probes.namesIn(projects)) {
    const root = readObject(probes.readText(join(projects, id, "memory.json")))?.project_root;
    if (typeof root === "string") roots.add(root);
  }
  return [...roots].filter((r) => isAbsolute(r)).sort();
}

/** The path with every link in it followed; the path as written when it cannot be followed. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Two spellings of one folder: another case on a case-insensitive disk, a link, a trailing slash. */
function sameFolder(a: string, b: string): boolean {
  const [x, y] = [statSync(a, { throwIfNoEntry: false }), statSync(b, { throwIfNoEntry: false })];
  if (x === undefined || y === undefined) return resolve(a) === resolve(b);
  return x.dev === y.dev && x.ino === y.ino;
}

/**
 * Is this path a data folder, or inside one? Asked of every would-be project
 * folder: a project recorded at the home folder has `~/.siltpoke` as "its"
 * `.siltpoke`, and that one has gates of its own (plugin-uninstall.ts). The
 * account's `~/.siltpoke` counts even when `SILTPOKE_HOME` points elsewhere.
 */
function isDataFolder(path: string, env: NodeJS.ProcessEnv): boolean {
  return [siltpokeRoot(env), join(homeDir(env), ".siltpoke")].some((data) => {
    if (sameFolder(path, data)) return true;
    const inside = relative(realPath(data), realPath(path));
    // `..` or `../x` is outside; a folder NAMED `..x` is not (review round 2, M-a).
    return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  });
}

function insideRepository(root: string, probes: PurgeProbes): boolean {
  // The real path: a root reached through a link has its repository above the
  // folder the link points at, not above the link (review round 1, I2).
  for (let dir = realPath(root); ; dir = dirname(dir)) {
    if (probes.exists(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Does git track anything in `<root>/.siltpoke`? Outside any repository the
 * answer is no without asking. Inside one, only git's own clean answer counts:
 * git missing, timing out or refusing the repository is "unknown", and unknown
 * is kept (story contingency 4).
 */
function gitVerdict(root: string, probes: PurgeProbes): "untracked" | "tracked" | "unknown" {
  if (!insideRepository(root, probes)) return "untracked";
  const listed = probes.exec("git", ["-C", root, "ls-files", "--", ".siltpoke"]);
  if (listed.status !== 0) return "unknown";
  return listed.stdout.trim().length > 0 ? "tracked" : "untracked";
}

/** The first settings file that switches the plugin on, or null. A file that cannot be parsed counts when it names the plugin. */
function plcEnabledIn(roots: readonly string[], env: NodeJS.ProcessEnv, probes: PurgeProbes): string | null {
  const dirs = [dirname(settingsJsonPath(env)), ...roots.map((r) => join(r, ".claude"))];
  for (const dir of dirs) {
    for (const name of probes.namesIn(dir).filter((n) => /^settings.*\.json$/.test(n) && !n.startsWith(BACKUP_NAME)).sort()) {
      const text = probes.readText(join(dir, name));
      if (text === null) continue;
      const settings = readObject(text);
      const enabled = settings ? (settings.enabledPlugins as Record<string, unknown> | undefined)?.[PLC_PLUGIN] === true : text.includes(PLC_PLUGIN);
      if (enabled) return join(dir, name);
    }
  }
  return null;
}

/** The siltpoke-specific tools, as they would be recorded, for a machine with no receipt entry for them (spec §5). */
const UNRECORDED_TOOLS: readonly { id: string; target: string; darwinOnly?: boolean }[] = [
  { id: "tool:ollama-model", target: OLLAMA_MODEL },
  { id: "tool:plc", target: PLC_PLUGIN },
  { id: "tool:swiftbar", target: SWIFTBAR_APP_PATH, darwinOnly: true },
];

/** What the purge level adds to the disk view: things found, and verdicts that keep an item out of reach. */
export function findPurgeItems(
  receipt: Receipt | null,
  env: NodeJS.ProcessEnv,
  probes: PurgeProbes,
): { found: FoundOnDisk[]; verdicts: Map<string, Verdict> } {
  const found: FoundOnDisk[] = [];
  const verdicts = new Map<string, Verdict>();

  const roots = knownProjectRoots(receipt, env, probes);
  for (const root of roots) {
    const target = join(root, ".siltpoke");
    // A project recorded at the home folder, however it is spelled: its `.siltpoke` IS the data folder.
    if (isDataFolder(target, env)) continue;
    const id = `${PROJECT_ID}${root}`;
    if (!probes.exists(root)) verdicts.set(id, { status: "root-missing" });
    else if (!probes.exists(target)) continue;
    else {
      const git = gitVerdict(root, probes);
      if (git !== "untracked") verdicts.set(id, { status: git === "tracked" ? "kept-git-tracked" : "kept-git-unknown" });
    }
    found.push({ id, kind: "user-data", target });
  }

  const claudeDir = dirname(settingsJsonPath(env));
  for (const name of probes.namesIn(claudeDir).filter((n) => n.startsWith(BACKUP_NAME)).sort()) {
    found.push({ id: `${BACKUP_ID}${join(claudeDir, name)}`, kind: "user-data", target: join(claudeDir, name) });
  }

  // A tool the receipt also names is dropped by the planner: the receipt's word wins.
  for (const tool of UNRECORDED_TOOLS) {
    if (tool.darwinOnly && probes.platform !== "darwin") continue;
    if (probes.toolPresent(tool) === true) found.push({ id: tool.id, kind: "outside-tool", target: tool.target });
  }

  if (receipt?.entries.some((e) => e.id === "tool:plc")) {
    const file = plcEnabledIn(roots, env, probes);
    if (file !== null) verdicts.set("tool:plc", { status: "kept-in-use", note: `enabled in ${file}` });
  }
  return { found, verdicts };
}

/** A value from the receipt that is safe to hand to a command as one argument. */
function arg(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/.test(value) ? value : null;
}

/**
 * The command that removes an outside tool, or null when this version has none
 * for it. Built from the item's target — the name the plan shows — and never
 * from the receipt's `undo`, so what runs is what was shown (review round 1, M2).
 */
function toolCommand(item: PlanItem): [cmd: string, args: string[]] | null {
  const name = arg(item.target);
  if (item.id === "tool:ollama-model") return name ? ["ollama", ["rm", name]] : null;
  if (item.id === "tool:plc") return name ? ["claude", ["plugin", "uninstall", name]] : null;
  if (item.id === "tool:swiftbar") return ["brew", ["uninstall", "--cask", "swiftbar"]];
  return null;
}

const TOOL_NAMES: Record<string, string> = {
  "tool:ollama-model": "the Ollama model",
  "tool:plc": "the Claude Code plugin",
  "tool:swiftbar": "the SwiftBar app",
};

/** One line for an outside tool in the plan. A general tool is its name and nothing else (AC17). */
export function describeTool(item: PlanItem): string {
  const name = TOOL_NAMES[item.id];
  if (name === undefined) return item.target;
  const what = `${name} ${item.target}`;
  if (item.status === "remove") {
    const unchecked = item.id === "tool:plc" ? "; projects Siltpoke never opened cannot be checked" : "";
    return `${what} — you may be using this elsewhere${unchecked}`;
  }
  const command = toolCommand(item);
  return item.status === "unknown-owner" && command ? `${what} (to remove it yourself: ${[command[0], ...command[1]].join(" ")})` : what;
}

const done = (line: string): UndoResult => ({ outcome: "done", line });
const notDone = (line: string): UndoResult => ({ outcome: "not-done", line });

function purgeProjectFolder(item: PlanItem, env: NodeJS.ProcessEnv, probes: PurgeProbes): UndoResult {
  const stat = lstatSync(item.target, { throwIfNoEntry: false });
  if (stat === undefined) return { outcome: "nothing" };
  // lstat: a link named `.siltpoke` is not a folder here, so it is never followed.
  const isOurs = basename(item.target) === ".siltpoke" && stat.isDirectory() && !isDataFolder(item.target, env);
  if (!isOurs) return notDone(`${item.target} is not a project's .siltpoke folder — left as it is.`);
  const git = gitVerdict(dirname(item.target), probes);
  if (git !== "untracked") {
    return notDone(`${item.target}: ${git === "tracked" ? "git tracks files in it" : "git could not say whether it tracks it"} — left as it is.`);
  }
  rmSync(item.target, { recursive: true, force: true });
  return done(`${item.target}: deleted`);
}

function purgeBackup(item: PlanItem, env: NodeJS.ProcessEnv): UndoResult {
  const stat = lstatSync(item.target, { throwIfNoEntry: false });
  if (stat === undefined) return { outcome: "nothing" };
  const isOurs = dirname(item.target) === dirname(settingsJsonPath(env)) && basename(item.target).startsWith(BACKUP_NAME) && !stat.isDirectory();
  if (!isOurs) return notDone(`${item.target} is not a settings copy Siltpoke made — left as it is.`);
  unlinkSync(item.target);
  return done(`${item.target}: deleted`);
}

function purgeTool(item: PlanItem, effects: PurgeEffects): UndoResult | null {
  // Only on the receipt's word that siltpoke installed it (spec §5).
  if (item.byUs !== true) return { outcome: "nothing" };
  if (TOOL_NAMES[item.id] === undefined) return null;
  const command = toolCommand(item);
  if (command === null) return notDone(`${item.target}: the recorded name is not one Siltpoke would pass to a command — nothing was run.`);
  const text = [command[0], ...command[1]].join(" ");
  return effects.run(...command).status === 0
    ? done(`${TOOL_NAMES[item.id]} ${item.target}: removed (\`${text}\`)`)
    : notDone(`\`${text}\` failed — run it yourself to see why.`);
}

/** Take one purge-level item away. null = this version has no executor for it. */
export function purgeItem(item: PlanItem, env: NodeJS.ProcessEnv, probes: PurgeProbes, effects: PurgeEffects): UndoResult | null {
  try {
    if (item.id.startsWith(PROJECT_ID)) return purgeProjectFolder(item, env, probes);
    if (item.id.startsWith(BACKUP_ID)) return purgeBackup(item, env);
    if (item.kind === "outside-tool") return purgeTool(item, effects);
    return null;
  } catch (err) {
    return notDone(`${item.target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The data step removes this one itself (the dashboard's start-at-login entry). */
const REMOVED_WITH_THE_DATA: ReadonlySet<string> = new Set(["launch-agent:daemon"]);

/**
 * What the receipt must still say once `~/.siltpoke` is deleted: the entries
 * for things siltpoke put on this machine that are still on it, and the
 * projects that still have a `.siltpoke/` folder. null = nothing left to
 * record, so the receipt goes with the folder (spec §4 step 5).
 *
 * The projects come from the plan, not from the receipt: the plan also knows
 * the roots read from `~/.siltpoke/projects/`, which is about to be deleted,
 * and it never lists the data folder itself as a project. Without them a
 * folder the user said No to could not be found by any later run (`[79]`).
 *
 * A folder git tracks is never siltpoke's to remove, so on its own it is no
 * reason to keep the receipt — it would keep it for good (review round 1). It
 * is still listed in a receipt kept for another reason. A folder git could not
 * answer for is a reason: the next run may get an answer.
 */
export function receiptToKeep(receipt: Receipt | null, plan: RemovalPlan): Receipt | null {
  const items = plan.groups.flatMap((g) => g.items);
  const still = new Set(
    items
      .filter((i) => i.source === "receipt" && (i.status === "remove" || i.status === "kept-in-use") && !REMOVED_WITH_THE_DATA.has(i.id))
      .map((i) => i.id),
  );
  const entries = (receipt?.entries ?? []).filter((e) => still.has(e.id));
  const folders = items.filter((i) => i.id.startsWith(PROJECT_ID) && i.status !== "root-missing");
  if (entries.length === 0 && folders.every((i) => i.status === "kept-git-tracked")) return null;
  // `[80]`: the install's own record of what it created, for the groups still to come — only what is still on disk.
  const created = (receipt?.created ?? []).filter((p) => existsSync(p));
  return {
    version: 1,
    entries,
    projects: folders.map((i) => i.id.slice(PROJECT_ID.length)),
    ...(created.length > 0 ? { created } : {}),
  };
}

/** Delete `~/.siltpoke`; with `keep`, everything in it except a receipt cut down to `keep`. */
export function deleteDataFolder(env: NodeJS.ProcessEnv, keep: Receipt | null): void {
  const dataDir = siltpokeRoot(env);
  if (keep === null) {
    rmSync(dataDir, { recursive: true, force: true });
    return;
  }
  writeTrimmedReceipt(keep, env);
  for (const name of readdirSync(dataDir)) {
    if (name !== "receipt.json") rmSync(join(dataDir, name), { recursive: true, force: true });
  }
}

/** `brew uninstall` and `ollama rm` on a large model take longer than a probe is allowed. */
const REMOVAL_TIMEOUT_MS = 5 * 60_000;

/** Run one removal command for real. Built into the CLI entry only — never inside a test. */
export function runOutsideTool(cmd: string, args: string[]): { status: number; stdout: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: REMOVAL_TIMEOUT_MS });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  } catch {
    return { status: 1, stdout: "" };
  }
}

/**
 * The real answers and the real commands, sharing one memory: a plan is built
 * two or three times in one call, and `claude plugin list` takes about a
 * second. Running a removal forgets what was heard, so the plan printed after
 * it is asked afresh.
 */
export function realOutsideTools(
  probe: ProbeExec,
  run: ProbeExec,
): { toolPresent: PurgeProbes["toolPresent"]; effects: PurgeEffects } {
  const heard = new Map<string, { status: number; stdout: string }>();
  const ask = (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    const answer = heard.get(key) ?? probe(cmd, args);
    heard.set(key, answer);
    return answer;
  };
  const listed = (cmd: string, args: string[], name: string): boolean | null => {
    const answer = ask(cmd, args);
    // A whole word of the listing, not a piece of one: `x:7b` is not `x:7b-instruct`.
    return answer.status === 0 ? answer.stdout.split(/[\s@]+/).includes(name) : null;
  };
  return {
    toolPresent: (tool) => {
      if (tool.id === "tool:swiftbar") return existsSync(tool.target);
      if (tool.id === "tool:ollama-model") return listed("ollama", ["list"], tool.target);
      if (tool.id === "tool:plc") return listed("claude", ["plugin", "list"], tool.target.split("@")[0] ?? tool.target);
      return Bun.which(tool.target === "claude-code" ? "claude" : tool.target) !== null;
    },
    effects: {
      run: (cmd, args) => {
        heard.clear();
        return run(cmd, args);
      },
    },
  };
}
