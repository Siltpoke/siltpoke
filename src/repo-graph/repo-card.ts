// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cheap ($0, no LLM) per-repo card digest for the Memory dashboard's
 * "active repos" rail. Joins a project (by its root path) to its repo-graph
 * index and reads three already-on-disk artifacts:
 *
 *   <home>/repo-memory/<proj_hash>/meta.json         — file count + index time
 *   <home>/repo-memory/<proj_hash>/arch-model.json   — areas (bands) + components
 *   <home>/repo-memory/<proj_hash>/repo-summary.json — cached 1-2 sentence blurb
 *
 * Returns null when the repo was never indexed (no meta.json). The arch-model
 * and summary are optional layers on top — a freshly-indexed repo has stats
 * but empty areas/components and a null summary until generated.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjHash } from "./proj-hash";

const REPO_MEMORY_DIR = "repo-memory";

export interface RepoCard {
  /** Total file nodes in the structural index. */
  files: number;
  /** Architecture component count (arch-model nodes); 0 if no arch-model. */
  components: number;
  /** ISO timestamp the structural index was last built. */
  indexed_at: string;
  /** Architecture-layer labels (arch-model bands), in model order. */
  areas: string[];
  /** Component titles (arch-model nodes), in model order. */
  component_titles: string[];
  /** Cached 1-2 sentence "what this repo is about" blurb; null until generated. */
  summary_text: string | null;
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Unwrap an arch-model `claim` ({ value, evidence, tier }) or a bare string. */
export function claimValue(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && "value" in x) {
    const v = (x as { value: unknown }).value;
    return typeof v === "string" ? v : "";
  }
  return "";
}

function claimTitles(list: unknown, key: "label" | "title"): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      item && typeof item === "object" ? claimValue((item as Record<string, unknown>)[key]) : "",
    )
    .filter((s) => s.length > 0);
}

/**
 * Load the repo-graph card digest for a project root, or null if the repo has
 * no structural index. Pure $0 disk reads; never throws.
 */
export function loadRepoCard(home: string, projectRoot: string): RepoCard | null {
  const dir = join(home, REPO_MEMORY_DIR, computeProjHash(projectRoot));

  const meta = readJsonObject(join(dir, "meta.json"));
  if (!meta) return null; // not indexed

  const counters = meta.counters;
  const nodes =
    counters && typeof counters === "object"
      ? (counters as Record<string, unknown>).nodes
      : undefined;
  const files =
    nodes && typeof nodes === "object" && typeof (nodes as Record<string, unknown>).file === "number"
      ? ((nodes as Record<string, unknown>).file as number)
      : 0;
  const indexed_at = typeof meta.last_indexed_ts === "string" ? meta.last_indexed_ts : "";

  const arch = readJsonObject(join(dir, "arch-model.json"));
  const areas = claimTitles(arch?.bands, "label");
  const component_titles = claimTitles(arch?.nodes, "title");

  const summary = readJsonObject(join(dir, "repo-summary.json"));
  const summary_text =
    summary && typeof summary.text === "string" && summary.text.trim().length > 0
      ? summary.text
      : null;

  return {
    files,
    components: component_titles.length,
    indexed_at,
    areas,
    component_titles,
    summary_text,
  };
}
