// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import type { Receipt, ReceiptEntry, ReceiptKind } from "../installer/receipt";

/**
 * The removal plan — `[61]` PR 2, S2 (spec
 * an internal design note §3, §5, §8 D-A).
 *
 * `buildPlan` is pure: the receipt and what is on disk go in as data, the plan
 * comes out. Nothing here reads a file or removes anything. Both front ends
 * show this plan and may only ask the CLI for groups that are in it.
 *
 * A group is one tool or one place, and is what the user says yes to (one yes
 * per tool, not per line).
 */

/** What the disk says, gathered by the caller. */
export interface DiskView {
  /** Ids of receipt entries whose target is still there. */
  present: ReadonlySet<string>;
  /** Things found on disk whose content names siltpoke, receipt or no receipt (D-A). */
  found: readonly FoundOnDisk[];
  /** By item id: why something that would be removed is out of reach instead (purge level, uninstall-purge.ts). */
  verdicts?: ReadonlyMap<string, Verdict>;
}

/** A reason the disk gives for not removing an item the receipt and the id alone would offer. */
export interface Verdict {
  status: "kept-git-tracked" | "kept-git-unknown" | "root-missing" | "kept-in-use";
  /** Shown after the item's line, e.g. which file. */
  note?: string;
}

export interface FoundOnDisk {
  /** The id the install path would have recorded for it. */
  id: string;
  kind: ReceiptKind;
  target: string;
}

export type PlanItemStatus =
  /** Ours, and still there: removed when the group is. */
  | "remove"
  /** The receipt says it was there before siltpoke acted. */
  | "kept-not-ours"
  /** No receipt entry, and the thing itself cannot say who put it there (spec §5). */
  | "unknown-owner"
  /** A general tool, or a shape this version does not know. */
  | "never-offered"
  /** Recorded as done, no longer on disk. */
  | "already-gone"
  /** A project's `.siltpoke/` that git tracks, or where git could not say (spec §4 step 2). */
  | "kept-git-tracked"
  | "kept-git-unknown"
  /** A recorded project that is no longer at that path. */
  | "root-missing"
  /** Ours, but a settings file still switches it on (spec §5, the PLC plugin). */
  | "kept-in-use";

export interface PlanItem {
  id: string;
  kind: ReceiptKind;
  target: string;
  /** null when there is no receipt entry to say. */
  byUs: boolean | null;
  source: "receipt" | "disk";
  status: PlanItemStatus;
  /** The receipt's undo, for the executor; null for an item found on disk. */
  undo: Record<string, unknown> | null;
  /** From the disk's verdict; not part of the plan id. */
  note?: string;
}

export interface PlanGroup {
  id: string;
  /** One plain-language line: what saying yes to this group removes. */
  title: string;
  level: "uninstall" | "purge";
  offer: "remove" | "list-only";
  items: PlanItem[];
}

export interface RemovalPlan {
  /** Changes whenever a group, an item, a target or a verdict changes. */
  planId: string;
  groups: PlanGroup[];
}

interface GroupSpec {
  id: string;
  title: string;
  level: "uninstall" | "purge";
}

/**
 * Shown in this order; hook hosts not named here follow `antigravity`, by name.
 * A title names the place and nothing else: what is in it is on the item
 * lines. A title that listed "status line, hooks, slash commands" was shown
 * above a group holding only the status line (real run, 2026-10-05).
 */
const GROUPS: readonly GroupSpec[] = [
  { id: "claude-code", title: "Siltpoke in Claude Code", level: "uninstall" },
  { id: "codex", title: "Siltpoke in codex", level: "uninstall" },
  { id: "codebuddy", title: "Siltpoke in codebuddy", level: "uninstall" },
  { id: "qoder", title: "Siltpoke in qoder", level: "uninstall" },
  { id: "antigravity", title: "Siltpoke in Antigravity", level: "uninstall" },
  { id: "dashboard", title: "The Siltpoke dashboard", level: "uninstall" },
  { id: "menubar", title: "The menu-bar pet", level: "uninstall" },
  // Purge order (spec §4): projects, settings copies, outside tools, and the data folder last —
  // it holds the list of projects, so it is read before it is deleted.
  { id: "project-data", title: "Siltpoke's review data inside your projects (a .siltpoke/ folder in each)", level: "purge" },
  { id: "settings-backups", title: "Copies of Claude Code's settings.json that each Siltpoke setup run left", level: "purge" },
  { id: "tool:ollama-model", title: "The local model Siltpoke pulled into Ollama", level: "purge" },
  { id: "tool:plc", title: "The project-lifecycle plugin", level: "purge" },
  { id: "tool:swiftbar", title: "The SwiftBar app", level: "purge" },
  { id: "general-tools", title: "General tools Siltpoke needs (other things may need them too)", level: "purge" },
  { id: "user-data", title: "Your Siltpoke data (~/.siltpoke): the pet, its memory, the review history — the dashboard is stopped and its start-at-login entry removed with it", level: "purge" },
  { id: "other", title: "Recorded by a different Siltpoke version", level: "uninstall" },
];

const KNOWN_GROUP_IDS: ReadonlySet<string> = new Set(GROUPS.map((g) => g.id));
const HOOK_HOSTS_BEFORE = GROUPS.findIndex((g) => g.id === "dashboard");

/** Never offered for removal, whoever installed them (spec §5). */
const GENERAL_TOOLS: ReadonlySet<string> = new Set(["tool:bun", "tool:git", "tool:claude-code", "tool:codex"]);
/** Offered at purge, and only when the receipt says they are ours (spec §5). */
const SILTPOKE_TOOLS: ReadonlySet<string> = new Set(["tool:ollama-model", "tool:plc", "tool:swiftbar"]);

/** A hook or status-line id names its host. One that collides with a non-host group is not a host. */
function hostGroup(recorded: string): string {
  // The install records qoder under its binary's name (`host-adapter.ts`).
  const host = recorded === "qodercli" ? "qoder" : recorded;
  const isHostGroup = GROUPS.findIndex((g) => g.id === host) < HOOK_HOSTS_BEFORE;
  if (!/^[a-z0-9-]+$/.test(host) || (KNOWN_GROUP_IDS.has(host) && !isHostGroup)) return "other";
  return host;
}

/**
 * A slash-command file belongs to the host whose commands folder it is in. The
 * id carries only the path, so the host is read off the folder's default name;
 * under a relocated host home (`CODEBUDDY_HOME`, `QODER_HOME`) the file is
 * still listed and still removable, under Claude Code's heading.
 */
function commandFileGroup(path: string): string {
  if (/[/\\]\.codebuddy[/\\]commands[/\\]/.test(path)) return "codebuddy";
  if (/[/\\]\.qoder[/\\]commands[/\\]/.test(path)) return "qoder";
  return "claude-code";
}

/** Which group an id belongs to. Reads the id and kind only — never the prose. */
function groupOf(id: string, kind: ReceiptKind): string {
  if (GENERAL_TOOLS.has(id)) return "general-tools";
  if (SILTPOKE_TOOLS.has(id)) return id;
  if (id.startsWith("data:project:")) return "project-data";
  if (id.startsWith("backup:")) return "settings-backups";
  if (kind === "user-data") return "user-data";
  const colon = id.indexOf(":");
  const prefix = colon < 0 ? "" : id.slice(0, colon);
  const rest = colon < 0 ? "" : id.slice(colon + 1);
  if (prefix === "statusline" || prefix === "hook") return hostGroup(rest);
  if (id === "launch-agent:daemon" || id === "process:daemon") return "dashboard";
  if (id === "launch-agent:swiftbar" || prefix === "pref") return "menubar";
  // Slash-command files are `.md`; the only other file siltpoke records is the menu-bar shim.
  if (prefix === "file") return rest.endsWith(".md") ? commandFileGroup(rest) : "menubar";
  return "other";
}

function statusOf(group: string, byUs: boolean | null, kind: ReceiptKind): PlanItemStatus {
  if (group === "general-tools" || group === "other") return "never-offered";
  if (byUs === false) return "kept-not-ours";
  if (byUs === null && (kind === "outside-tool" || kind === "macos-pref")) return "unknown-owner";
  return "remove";
}

function fromReceipt(e: ReceiptEntry, present: boolean): PlanItem | null {
  // Spec §2.1: a pending entry means "check the disk" — absent ⇒ the action never happened.
  if (!present && e.state === "pending") return null;
  return {
    id: e.id,
    kind: e.kind,
    target: e.target,
    byUs: e.byUs,
    source: "receipt",
    status: present ? statusOf(groupOf(e.id, e.kind), e.byUs, e.kind) : "already-gone",
    undo: e.undo,
  };
}

function fromDisk(f: FoundOnDisk): PlanItem {
  return {
    id: f.id,
    kind: f.kind,
    target: f.target,
    byUs: null,
    source: "disk",
    status: statusOf(groupOf(f.id, f.kind), null, f.kind),
    undo: null,
  };
}

function specFor(id: string): GroupSpec {
  return GROUPS.find((g) => g.id === id) ?? { id, title: `Siltpoke in ${id}`, level: "uninstall" };
}

function orderOf(id: string): number {
  const i = GROUPS.findIndex((g) => g.id === id);
  return i < 0 ? HOOK_HOSTS_BEFORE - 0.5 : i;
}

/**
 * The plan for this receipt and this disk. A missing and an unreadable receipt
 * both arrive as null (`readReceipt`) and are treated alike: wiring that names
 * siltpoke is still offered, things whose owner cannot be read off the thing
 * are listed only.
 */
export function buildPlan(receipt: Receipt | null, disk: DiskView): RemovalPlan {
  const entries = receipt?.entries ?? [];
  const recorded = new Set(entries.map((e) => e.id));
  const items: PlanItem[] = [
    ...entries.map((e) => fromReceipt(e, disk.present.has(e.id))).filter((i): i is PlanItem => i !== null),
    // The receipt's verdict wins over the same thing seen on disk.
    ...disk.found.filter((f) => !recorded.has(f.id)).map(fromDisk),
  ].map((item) => {
    // A verdict only ever takes an item out of reach; it never offers one.
    const verdict = item.status === "remove" ? disk.verdicts?.get(item.id) : undefined;
    return verdict ? { ...item, status: verdict.status, ...(verdict.note ? { note: verdict.note } : {}) } : item;
  });

  const byGroup = new Map<string, PlanItem[]>();
  for (const item of items) {
    const id = groupOf(item.id, item.kind);
    byGroup.set(id, [...(byGroup.get(id) ?? []), item]);
  }

  const groups: PlanGroup[] = [...byGroup.entries()]
    .sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b))
    .map(([id, groupItems]) => ({
      ...specFor(id),
      offer: groupItems.some((i) => i.status === "remove") ? ("remove" as const) : ("list-only" as const),
      items: groupItems,
    }));

  return { planId: planIdOf(groups), groups };
}

/** Order-independent: the same facts give the same id whatever order they were recorded in. */
function planIdOf(groups: readonly PlanGroup[]): string {
  const lines = groups
    .flatMap((g) => g.items.map((i) => JSON.stringify([g.id, g.offer, i.id, i.target, i.status])))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}
