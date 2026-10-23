// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { newlyCreated } from "./created-paths";
import { findInstalledVersion } from "./installed-version";
import { homeDir, siltpokeRoot } from "./paths";

/**
 * The install receipt — `[61]` PR 2, S1 (spec
 * an internal design note §2).
 *
 * Every install path records what it is about to touch BEFORE it acts
 * (`recordBefore`, state `pending`) and flips the entry after (`markDone`).
 * Uninstall later builds its removal plan from this file plus the disk: a
 * `done` entry is trusted, a `pending` one means "check the disk" — a crash
 * mid-action leaves `pending`, never a false `done` (spec §2.1).
 *
 * This module is the ONLY writer of the file. Setup and configure never
 * rewrite it wholesale; every change is a read-modify-write of one entry.
 *
 * Residual, stated rather than implied: there is no lock. Two siltpoke
 * processes writing the receipt in the same instant can lose one write (last
 * rename wins). Install paths run one at a time in one process; the hooks'
 * `addProjectRoot` can race an install, and the planner's disk check plus
 * `~/.siltpoke/projects/*` (spec §4 step 1) are the second source for that.
 */

/** Spec §2.2. */
export type ReceiptKind =
  | "statusline"
  | "host-hook"
  | "launch-agent"
  | "macos-pref"
  | "file"
  | "outside-tool"
  | "user-data";

const KINDS: readonly string[] = [
  "statusline",
  "host-hook",
  "launch-agent",
  "macos-pref",
  "file",
  "outside-tool",
  "user-data",
];

/** What a call site passes in; state, time and version are filled here. */
export interface NewReceiptEntry {
  /** Stable `kind:target`-style id; the removal plan's ids are these. */
  id: string;
  kind: ReceiptKind;
  /** What was touched (a path, a pref domain, a tool name). */
  target: string;
  /** Observed at that moment: false = it was already there before siltpoke acted. */
  byUs: boolean;
  /** Which uninstall level offers it (spec §4). */
  level: "uninstall" | "purge";
  /** How to undo it; shape depends on `kind`, read by the planner. */
  undo: Record<string, unknown>;
}

export interface ReceiptEntry extends NewReceiptEntry {
  state: "pending" | "done";
  /** ISO time of the last `recordBefore` for this id. */
  at: string;
  /** null when the running version could not be found — never invented. */
  siltpokeVersion: string | null;
}

export interface Receipt {
  version: 1;
  entries: ReceiptEntry[];
  /** Repo roots where siltpoke wrote `{repo}/.siltpoke/` (spec §2.3). */
  projects: string[];
  /**
   * `[80]`: files and folders an install newly created (absent when it ran,
   * observed before it acted). Uninstall deletes one only while it is empty.
   * Absent in a receipt written before this field existed — read as none.
   */
  created?: string[];
}

interface RecordOptions {
  now?: Date;
  /** Omitted ⇒ looked up from the running install; null ⇒ unknown. */
  version?: string | null;
}

export function receiptPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(siltpokeRoot(env), "receipt.json");
}

/**
 * The receipt, or null when there is none OR it cannot be read (not JSON,
 * wrong shape). Never throws. The planner treats both nulls alike (plan P2.1).
 */
export function readReceipt(env: NodeJS.ProcessEnv = process.env): Receipt | null {
  const path = receiptPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write (or update) the entry with state `pending`, before the action runs.
 * The same id updates in place — one entry per id, ever. `byUs` is frozen once
 * the entry is `done`: a re-run finds the thing present because an earlier run
 * (or the user) put it there, which says nothing new about who did. A `pending`
 * entry's `byUs` may be replaced by the later observation (the maintainer's decision,
 * 2026-10-05): a pending "ours" later seen present becomes "not ours" —
 * better not to offer removal than to remove something that is the user's.
 */
export function recordBefore(
  entry: NewReceiptEntry,
  env: NodeJS.ProcessEnv = process.env,
  opts: RecordOptions = {},
): void {
  const receipt = loadForWrite(env);
  const prior = receipt.entries.find((e) => e.id === entry.id);
  const next: ReceiptEntry = {
    ...entry,
    byUs: prior?.state === "done" ? prior.byUs : entry.byUs, // frozen once done
    state: "pending",
    at: (opts.now ?? new Date()).toISOString(),
    siltpokeVersion: opts.version !== undefined ? opts.version : findInstalledVersion(import.meta.dir),
  };
  const entries = prior
    ? receipt.entries.map((e) => (e.id === entry.id ? next : e))
    : [...receipt.entries, next];
  const created = withCreated(receipt.created, entry, env);
  save(env, { ...receipt, entries, ...(created ? { created } : {}) });
}

/** The receipt's `created` list plus what this entry's install is about to create; undefined = nothing to say. */
function withCreated(prior: string[] | undefined, entry: NewReceiptEntry, env: NodeJS.ProcessEnv): string[] | undefined {
  let fresh: string[] = [];
  try {
    fresh = newlyCreated(entry.target, entry.kind, homeDir(env));
  } catch {
    // No usable home: nothing can be said to be inside it.
  }
  if (fresh.length === 0) return prior;
  return [...(prior ?? []), ...fresh.filter((p) => !prior?.includes(p))];
}

/**
 * For a folder the install makes with no receipt entry of its own to hang it on
 * (the slash-command folder): call BEFORE the mkdir, so the folders about to be
 * made are seen as missing.
 */
export function recordCreatedDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const receipt = loadForWrite(env);
  // A made-up file name under it: `newlyCreated` lists the folders above a file, `dir` first.
  const created = withCreated(receipt.created, { ...CREATED_PROBE, target: join(dir, "x") }, env);
  if (created !== receipt.created) save(env, { ...receipt, created: created ?? [] });
}

const CREATED_PROBE: NewReceiptEntry = { id: "", kind: "file", target: "", byUs: true, level: "uninstall", undo: {} };

/** Replace the `created` list (the sweep keeps only what is still on the disk). No-op without a receipt. */
export function replaceCreated(created: string[], env: NodeJS.ProcessEnv = process.env): void {
  const receipt = readReceipt(env);
  if (!receipt) return;
  save(env, { ...receipt, created });
}

/** Flip one entry to `done`. False (and nothing written) when the id is not there. */
export function markDone(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const receipt = readReceipt(env);
  if (!receipt?.entries.some((e) => e.id === id)) return false;
  save(env, {
    ...receipt,
    entries: receipt.entries.map((e) => (e.id === id ? { ...e, state: "done" } : e)),
  });
  return true;
}

/** Where `install/bootstrap.sh` / `bootstrap.ps1` leave their note about bun (spec §2.3). */
export function bootstrapFragmentPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(siltpokeRoot(env), "receipt-bootstrap.json");
}

/**
 * Fold the bootstrap script's note about bun into the receipt, then delete the
 * note. The script runs before any siltpoke code exists, so it can only leave a
 * one-line JSON file: `{"id":"tool:bun","byUs":<bool>,"state":"pending"|"done"}`
 * (`byUs` = bun was NOT on PATH before the script acted; `pending` = the bun
 * installer was started and has not finished).
 *
 * The file is untrusted input: it must be exactly that shape, for `tool:bun`
 * only, or it is dropped. An entry for bun that is already in the receipt wins
 * over the note — a later run that finds bun on PATH (because an earlier run put
 * it there) must not turn "ours" into "was already there". Never throws.
 */
export function mergeBootstrapFragment(
  env: NodeJS.ProcessEnv = process.env,
  deps: { record?: typeof recordBefore } = {},
): void {
  const path = bootstrapFragmentPath(env);
  if (!existsSync(path)) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    // Not JSON: dropped below like any other bad shape.
  }
  const f = parsed as { id?: unknown; byUs?: unknown; state?: unknown } | null;
  const valid =
    !!f &&
    typeof f === "object" &&
    f.id === "tool:bun" &&
    typeof f.byUs === "boolean" &&
    (f.state === "pending" || f.state === "done");
  const existing = valid ? readReceipt(env)?.entries.find((e) => e.id === "tool:bun") : undefined;
  if (valid && existing?.state === "pending" && f.state === "done") {
    // An earlier merge recorded the entry and died before markDone: finish it from the note.
    try {
      markDone("tool:bun", env);
    } catch {
      return;
    }
  } else if (valid && !existing) {
    try {
      (deps.record ?? recordBefore)(
        {
          id: "tool:bun",
          kind: "outside-tool",
          target: "bun",
          byUs: f.byUs as boolean,
          level: "purge",
          undo: { type: "none", reason: "general tool — never offered for removal (spec §5)" },
        },
        env,
      );
      if (f.state === "done") markDone("tool:bun", env);
    } catch {
      // Could not write the receipt: keep the note, the next run tries again.
      return;
    }
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // Left behind: the next run reads it again, and the same-id rule keeps that harmless.
  }
}

/** Remember a repo root that got a `.siltpoke/` folder. No-op when already listed. */
export function addProjectRoot(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const receipt = loadForWrite(env);
  if (receipt.projects.includes(root)) return;
  save(env, { ...receipt, projects: [...receipt.projects, root] });
}

/**
 * Purge deletes `~/.siltpoke` and leaves this behind: the receipt cut down to
 * the things still on the machine (spec §4 step 5). The one whole-file write,
 * and still through this module.
 */
export function writeTrimmedReceipt(receipt: Receipt, env: NodeJS.ProcessEnv = process.env): void {
  save(env, receipt);
}

/**
 * The receipt to modify. An unreadable file is moved aside (never
 * overwritten — it may still be worth reading by hand) and a fresh receipt
 * starts. The planner never saw its contents either way.
 */
function loadForWrite(env: NodeJS.ProcessEnv): Receipt {
  const path = writablePath(env);
  const existing = readReceipt(env);
  if (existing) return existing;
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      // Could not move it: the write below replaces it. Losing an unreadable
      // file beats leaving every install path unable to record.
    }
  }
  return { version: 1, entries: [], projects: [] };
}

function save(env: NodeJS.ProcessEnv, receipt: Receipt): void {
  atomicWrite(writablePath(env), `${JSON.stringify(receipt, null, 2)}\n`);
}

/**
 * The receipt path, for a write. Install paths default to `process.env`, so a
 * test that forgets to pass a sandbox env would touch the developer's real
 * receipt. Under `bun test` (NODE_ENV=test) that one path is refused, loudly —
 * a red test, never a silently edited real file (memory:
 * test-omitting-env-writes-the-real-install).
 */
function writablePath(env: NodeJS.ProcessEnv): string {
  const path = receiptPath(env);
  // `process.env.HOME`, not `os.homedir()`: under Bun the latter does not
  // follow a runtime change to HOME, and the env a forgetful test inherits IS
  // `process.env`.
  const realDefault = receiptPath({ HOME: process.env.HOME ?? homedir() });
  if (process.env.NODE_ENV === "test" && path === realDefault) {
    throw new Error(`receipt: refusing to write ${path} under bun test — pass a sandbox env`);
  }
  return path;
}

function isReceipt(v: unknown): v is Receipt {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.version === 1 &&
    Array.isArray(r.entries) &&
    r.entries.every(isEntry) &&
    Array.isArray(r.projects) &&
    r.projects.every((p) => typeof p === "string") &&
    (r.created === undefined || (Array.isArray(r.created) && r.created.every((p) => typeof p === "string")))
  );
}

function isEntry(v: unknown): v is ReceiptEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.kind === "string" &&
    KINDS.includes(e.kind) &&
    typeof e.target === "string" &&
    typeof e.byUs === "boolean" &&
    (e.state === "pending" || e.state === "done") &&
    typeof e.at === "string" &&
    (e.siltpokeVersion === null || typeof e.siltpokeVersion === "string") &&
    (e.level === "uninstall" || e.level === "purge") &&
    !!e.undo &&
    typeof e.undo === "object" &&
    !Array.isArray(e.undo)
  );
}
