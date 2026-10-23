// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Prices and capability tags from models.dev (spec §12.2, §12.5) — what the
 * Change-model window sorts by and shows under "What it's for".
 *
 * Only sourced facts: price per 1M tokens in and out, and tags taken straight
 * from models.dev fields (`reasoning`, `tool_call`, `limit.context`,
 * `open_weights`). Never our own "best at". Prices only sort the list; they are
 * never presented as what a call cost the user.
 *
 * WHICH PRICE. models.dev lists one model under many providers — the maker and
 * every reseller — at different prices. The maker's own entry is used: the
 * provider whose key is the vendor in `canonical_model_id`
 * (`anthropic/claude-haiku-4-5` → provider `anthropic`). A model only resellers
 * list keeps its tags and shows no price, rather than whichever reseller came
 * first.
 *
 * MATCHING. By id, case-insensitive, with any `vendor/` prefix dropped. One
 * narrow extra rule for agy: its ids carry a reasoning-effort or thinking
 * suffix (`gemini-3.8-flash-high`, `claude-opus-4-6-thinking`); with no exact
 * match the suffix is dropped once and the lookup retried. An agent's own tier
 * name (`Auto`, `fast-model`) is never looked up.
 *
 * The 5.6 MB api.json is reduced to this index and saved as
 * `<home>/models-dev.json`; offline, the saved copy is used and marked offline.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

export interface ModelFacts {
  /** $ per 1M input tokens; null = no price from the model's maker. */
  input: number | null;
  output: number | null;
  /** What tells models apart: context size, reads images / PDF, open weights. */
  tags: string[];
  /** The maker's one-line description, word for word; null = none. Absent in copies saved before 2026-10-15. */
  description?: string | null;
}

export type FactsIndex = Record<string, ModelFacts>;

export interface LoadedFacts {
  index: FactsIndex;
  /** Anthropic's own models, newest first — claude has no list command. [] = none known. */
  claudeModels: string[];
  /** When the saved copy was fetched (ISO); null = never. */
  fetchedAt: string | null;
  /** True when this load asked models.dev and could not reach it (or got junk). */
  offline: boolean;
  /** False for a saved-copy read that did not ask models.dev at all. */
  checked?: boolean;
}

const API_URL = "https://models.dev/api.json";
const CACHE = "models-dev.json";
const FETCH_TIMEOUT_MS = 10_000;
const AGY_SUFFIX = /-(low|medium|high|thinking)$/;

const bare = (id: string): string => (id.toLowerCase().split("/").pop() ?? "").trim();

interface RawModel {
  id?: unknown;
  description?: unknown;
  release_date?: unknown;
  open_weights?: unknown;
  limit?: { context?: unknown };
  cost?: { input?: unknown; output?: unknown };
  canonical_model_id?: unknown;
}

function contextTag(n: unknown): string | null {
  if (typeof n !== "number" || n <= 0) return null;
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M") : `${Math.round(n / 1000)}K`;
}

// No "reasoning" or "tools": nearly every model has both, so on every row they
// told the reader nothing; no "images" / "PDF" either — every claude had both,
// and OpenRouter's "vision" tag says it where it matters.
function tagsOf(m: RawModel): string[] {
  const tags: string[] = [];
  const ctx = contextTag(m.limit?.context);
  if (ctx !== null) tags.push(ctx);
  if (m.open_weights === true) tags.push("open weights");
  return tags;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

const DATED = /-\d{8}$/;

/**
 * Anthropic's own models on models.dev, newest release first. A dated id
 * (`claude-haiku-4-5-20251001`) is left out when its undated name is listed:
 * the same model twice. claude has no list command, so this is its list.
 */
export function claudeModelsOf(api: unknown): string[] {
  const models = (api as { anthropic?: { models?: unknown } } | null)?.anthropic?.models;
  if (models === null || typeof models !== "object") return [];
  const all = Object.entries(models as Record<string, RawModel>).filter(([, m]) => m !== null && typeof m === "object");
  // `key`, not `id`: with this and line 110 both `([id]) => id`, the repo-graph
  // extractor emitted `function:…model-prices.ts:id` twice, which put
  // `eval:repo-graph-state` over its baseline (52 vs 50). Renaming one clears it.
  const ids = new Set(all.map(([key]) => key));
  return all
    .filter(([id]) => !(DATED.test(id) && ids.has(id.replace(DATED, ""))))
    .sort(([, a], [, b]) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))
    .map(([id]) => id);
}

/** Reduce models.dev's api.json to one entry per bare id. Junk in → {}. */
export function buildFactsIndex(api: unknown): FactsIndex {
  const index: FactsIndex = {};
  if (api === null || typeof api !== "object") return index;
  const entries: { providerKey: string; id: string; raw: RawModel }[] = [];
  for (const [providerKey, provider] of Object.entries(api as Record<string, unknown>)) {
    const models = (provider as { models?: unknown } | null)?.models;
    if (models === null || typeof models !== "object") continue;
    for (const [key, raw] of Object.entries(models as Record<string, RawModel>)) {
      if (raw === null || typeof raw !== "object") continue;
      const id = bare(key);
      if (id.length > 0) entries.push({ providerKey, id, raw });
    }
  }
  // Pass 1: who makes each model, from any entry that says so. The maker's own
  // entry often does not (anthropic's claude-sonnet-4-6 has no canonical id).
  const makerOf = new Map<string, string>();
  for (const { id, raw } of entries) {
    const vendor = typeof raw.canonical_model_id === "string" ? raw.canonical_model_id.split("/")[0] : "";
    if (vendor && !makerOf.has(id)) makerOf.set(id, vendor);
  }
  // Pass 2: the maker's entry gives the price; any entry gives the tags.
  const fromMaker = new Set<string>();
  for (const { providerKey, id, raw } of entries) {
    if (fromMaker.has(id)) {
      // The maker's price stands; its words too, unless it wrote none.
      if (!index[id]?.description) index[id] = { ...(index[id] as ModelFacts), description: text(raw.description) };
      continue;
    }
    if (makerOf.get(id) === providerKey) {
      // The maker's words win; a reseller's description stands only when the maker wrote none.
      const description = text(raw.description) ?? index[id]?.description ?? null;
      index[id] = { input: num(raw.cost?.input), output: num(raw.cost?.output), tags: tagsOf(raw), description };
      fromMaker.add(id);
    } else if (index[id] === undefined) {
      index[id] = { input: null, output: null, tags: tagsOf(raw), description: text(raw.description) };
    } else if (!index[id].description) {
      index[id] = { ...index[id], description: text(raw.description) };
    }
  }
  return index;
}

export function lookupFacts(index: FactsIndex, id: string, opts: { tier?: boolean } = {}): ModelFacts | null {
  if (opts.tier === true) return null;
  const key = bare(id);
  return index[key] ?? (AGY_SUFFIX.test(key) ? (index[key.replace(AGY_SUFFIX, "")] ?? null) : null);
}

type Saved = Pick<LoadedFacts, "index" | "fetchedAt" | "claudeModels">;
const NOTHING_SAVED: Saved = { index: {}, fetchedAt: null, claudeModels: [] };

function readCache(home: string): Saved {
  const path = join(home, CACHE);
  if (!existsSync(path)) return NOTHING_SAVED;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { index?: unknown; fetchedAt?: unknown; claudeModels?: unknown };
    return {
      index: parsed.index && typeof parsed.index === "object" ? (parsed.index as FactsIndex) : {},
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
      claudeModels: Array.isArray(parsed.claudeModels)
        ? parsed.claudeModels.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return NOTHING_SAVED;
  }
}

const defaultFetch = (): Promise<Response> => fetch(API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/**
 * The facts to show. Fetches models.dev and saves the reduced index; on any
 * failure (offline, error status, a reply with no models in it) returns the
 * saved copy marked offline. `cachedOnly` = no fetch: the window's first,
 * instant read.
 */
export async function loadModelFacts(
  home: string,
  fetchFn: () => Promise<Response> = defaultFetch,
  now: Date = new Date(),
  opts: { cachedOnly?: boolean } = {},
): Promise<LoadedFacts> {
  const saved = readCache(home);
  if (opts.cachedOnly === true) return { ...saved, offline: false, checked: false };
  try {
    const res = await fetchFn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const api: unknown = await res.json();
    const index = buildFactsIndex(api);
    const claudeModels = claudeModelsOf(api);
    if (Object.keys(index).length === 0) throw new Error("no models in the reply");
    const fetchedAt = now.toISOString();
    atomicWrite(join(home, CACHE), `${JSON.stringify({ fetchedAt, index, claudeModels })}\n`);
    return { index, fetchedAt, claudeModels, offline: false };
  } catch {
    return { ...saved, offline: true };
  }
}
