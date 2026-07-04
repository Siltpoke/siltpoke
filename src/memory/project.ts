// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-project memory store + project-root resolution.
 *
 * resolveProjectRoot(cwd) walks up looking for `.siltpoke/marker.json`
 * (highest priority), then `.git/` (default), with a cwd-hash fallback for
 * directories that are neither. project_id is a 16-char sha256 of the
 * project's INITIAL absolute path — stable across renames as long as the
 * marker stays (or git root stays). project_root is the CURRENT path and
 * updates via `siltpoke relocate`.
 *
 * Per-project memory lives at `<home>/projects/<project_id>/memory.json`.
 * Identical atomic write + quarantine semantics as global.ts / memory.ts.
 */
import { writeFile, rename, readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { quarantineCorrupt } from "../utils/quarantine";
import {
  projectMemorySchema,
  markerSchema,
  type ProjectMemory,
  type Marker,
} from "./schema-v3";

const PROJECTS_DIR = "projects";
const FILENAME = "memory.json";
const MARKER_FILENAME = "marker.json";
const MARKER_DIR = ".siltpoke";

export type ProjectSource = "marker" | "git" | "fallback";

export interface ResolvedProject {
  project_id: string;
  project_root: string;
  display_name: string;
  source: ProjectSource;
}

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function tryReadMarker(path: string): Marker | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const result = markerSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `cwd` to filesystem root looking for either
 * `.siltpoke/marker.json` (highest priority) or `.git/`. Marker wins because
 * the user opted in explicitly and the marker encodes a stable project_id
 * that survives directory renames.
 *
 * Returns the resolution with the source tagged. Never throws.
 */
export function resolveProjectRoot(cwd: string): ResolvedProject {
  let dir = cwd;
  while (true) {
    const markerPath = join(dir, MARKER_DIR, MARKER_FILENAME);
    const marker = tryReadMarker(markerPath);
    if (marker) {
      return {
        project_id: marker.project_id,
        project_root: dir,
        display_name: marker.display_name,
        source: "marker",
      };
    }
    if (isDir(join(dir, ".git"))) {
      return {
        project_id: hashId(dir),
        project_root: dir,
        display_name: basename(dir) || dir,
        source: "git",
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: ephemeral project rooted at cwd, prefixed so it never collides
  // with a real path-hash.
  return {
    project_id: hashId(`__cwd_hash_${cwd}`),
    project_root: cwd,
    display_name: basename(cwd) || cwd,
    source: "fallback",
  };
}

export function emptyProject(
  resolved: ResolvedProject,
  now: Date = new Date(),
): ProjectMemory {
  const iso = now.toISOString();
  return {
    schemaVersion: 3,
    project_id: resolved.project_id,
    project_root: resolved.project_root,
    display_name: resolved.display_name,
    facts: [],
    event_fragments: [],
    episodes: [],
    chat_sessions: [],
    learned_rules: [],
    long_term_summary: "",
    last_consolidated_at: iso,
    consolidation_due_at: iso,
    personality_drift: {
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
      curiosity: 0,
    },
    user_profile_override: {
      goals: [],
      constraints: [],
      prefs: {},
      communication_style: null,
    },
  };
}

function projectDir(home: string, projectId: string): string {
  return join(home, PROJECTS_DIR, projectId);
}

function projectPath(home: string, projectId: string): string {
  return join(projectDir(home, projectId), FILENAME);
}

export async function readProject(
  home: string,
  projectId: string,
): Promise<ProjectMemory | null> {
  const path = projectPath(home, projectId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    const raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(path);
    return null;
  }
  const result = projectMemorySchema.safeParse(parsed);
  if (!result.success) {
    await quarantineCorrupt(path);
    return null;
  }
  return result.data;
}

export async function writeProject(
  home: string,
  projectId: string,
  memory: ProjectMemory,
): Promise<void> {
  try {
    const dir = projectDir(home, projectId);
    await mkdir(dir, { recursive: true });
    const finalPath = projectPath(home, projectId);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(memory, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // never crash caller
  }
}

export function projectMemoryPath(home: string, projectId: string): string {
  return projectPath(home, projectId);
}

export function projectMemoryDir(home: string, projectId: string): string {
  return projectDir(home, projectId);
}

/**
 * Create-only registration of a memory-project store. Registers an empty-but-valid
 * store so the repo appears in the "active repos" rail; NO-OPS when a store already
 * exists so real facts are never clobbered (the guard IS the safety — a re-index
 * must not reset a fact-bearing store).
 *
 * `target` is a cwd/root string (resolved via `resolveProjectRoot` → the same
 * `[:16]` identity the repo-graph card joins against) OR an already-resolved
 * project. Never pass a raw hash — the resolution guarantees the rail↔card join.
 *
 * `created:true` is a TRUTHFUL success signal: `writeProject` swallows its own fs
 * errors (never throws), so we re-read after the write to confirm the store landed
 * and THROW when it did not. That lets the caller's error path actually fire on a
 * real write failure (disk full / permission) instead of a silent false-positive.
 */
export async function ensureProject(
  home: string,
  target: string | ResolvedProject,
  now: Date = new Date(),
): Promise<{ project_id: string; created: boolean }> {
  const resolved = typeof target === "string" ? resolveProjectRoot(target) : target;
  const existing = await readProject(home, resolved.project_id);
  if (existing) {
    return { project_id: resolved.project_id, created: false };
  }
  await writeProject(home, resolved.project_id, emptyProject(resolved, now));
  // writeProject never throws — verify the store actually persisted so a silent
  // fs failure surfaces to the caller rather than reporting a false `created:true`.
  const confirmed = await readProject(home, resolved.project_id);
  if (!confirmed) {
    throw new Error(
      `ensureProject: memory-project store did not persist for ${resolved.project_id}`,
    );
  }
  return { project_id: resolved.project_id, created: true };
}

/**
 * A project the user has touched, as surfaced by the "active repos" rail. All
 * fields are derive-on-read from each `<home>/projects/<id>/memory.json` — no
 * LLM, no new persisted state.
 */
export interface ActiveProject {
  project_id: string;
  project_root: string;
  display_name: string;
  /** ISO — max(last_consolidated_at, newest chat ended_at/started_at). Drives the newest-first sort. */
  last_active_at: string;
  // chat_count / latest_summary are computed but NOT rendered by the current
  // (repo-graph) card — kept as forward-looking fields for a possible chat badge.
  chat_count: number;
  /** Newest chat's summary; falls back to long_term_summary; "" when neither exists. */
  latest_summary: string;
}

/**
 * Enumerate every per-project memory store under `<home>/projects/` and project
 * each into an {@link ActiveProject} digest, newest-active first. Corrupt or
 * schema-invalid stores are skipped (readProject quarantines them); a missing
 * projects/ dir yields []. Never throws.
 */
export async function listActiveProjects(home: string): Promise<ActiveProject[]> {
  const root = join(home, PROJECTS_DIR);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const out: ActiveProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await readProject(home, entry.name);
    if (!project) continue;

    let newestChatTs = "";
    let newestChatSummary = "";
    for (const chat of project.chat_sessions) {
      const ts = chat.ended_at ?? chat.started_at;
      if (ts > newestChatTs) {
        newestChatTs = ts;
        newestChatSummary = chat.summary;
      }
    }

    const last_active_at =
      newestChatTs > project.last_consolidated_at ? newestChatTs : project.last_consolidated_at;
    const latest_summary =
      newestChatSummary.trim().length > 0 ? newestChatSummary : project.long_term_summary;

    out.push({
      project_id: project.project_id,
      project_root: project.project_root,
      display_name: project.display_name,
      last_active_at,
      chat_count: project.chat_sessions.length,
      latest_summary,
    });
  }
  // Descending by ISO timestamp via plain string comparison (locale-proof for
  // pure-digit ISO strings). A store with no consolidation AND no timestamped
  // chats yields last_active_at === "" — sort those to the end explicitly
  // rather than relying on "" losing every comparison by accident.
  out.sort((a, b) => {
    if (a.last_active_at === b.last_active_at) return 0;
    if (a.last_active_at === "") return 1;
    if (b.last_active_at === "") return -1;
    return a.last_active_at < b.last_active_at ? 1 : -1;
  });
  return out;
}
