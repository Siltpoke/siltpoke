// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What each model is for, from OpenRouter's public model list
 * (`https://openrouter.ai/api/v1/models`, no key). models.dev's one line read
 * alike for every model; OpenRouter says what a model
 * is good at and what it replaces, its knowledge cutoff when known, and the
 * day it retires when one is set. Each guide links to the model's own page.
 *
 * The list's descriptions stop at about 200 characters; the page has the rest.
 * Matching ignores case, the vendor prefix and `.` vs `-` (`claude-haiku-5-5`
 * is OpenRouter's `anthropic/claude-haiku-5.5`). A `~` alias and a `:free`
 * copy are not a model's own entry. The reduced index is saved as
 * `<home>/openrouter-models.json`; offline, the saved copy is used.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

export interface ModelGuide {
  /** OpenRouter's description, markdown links read as their words. */
  text: string;
  /** What the description says the model is for, as tags (`guideTags`). */
  tags: string[];
  /** Its first sentence, without the model's own name, cut short (`shortLine`). */
  short: string;
  /** "YYYY-MM"; null = OpenRouter does not say. */
  knowsUpTo: string | null;
  /** "YYYY-MM-DD"; null = no retirement set. */
  retiresOn: string | null;
  /** The model's page on openrouter.ai. */
  url: string;
}

export type GuideIndex = Record<string, ModelGuide>;

export interface LoadedGuides {
  index: GuideIndex;
  fetchedAt: string | null;
  offline: boolean;
  /** False for a saved-copy read that did not ask OpenRouter. */
  checked?: boolean;
}

const API_URL = "https://openrouter.ai/api/v1/models";
const CACHE = "openrouter-models.json";
const FETCH_TIMEOUT_MS = 10_000;
const AGY_SUFFIX = /-(low|medium|high|thinking)$/;
const SAFE_ID = /^[a-z0-9._:/-]+$/i;

/** `anthropic/claude-haiku-5.5` and `claude-haiku-5-5` both → `claude-haiku-5-5`. */
const key = (id: string): string =>
  (id.toLowerCase().split("/").pop() ?? "")
    .replace(/:.*$/, "")
    .replace(/-\d{8}$/, "") // `claude-haiku-4-5-20251001` is `claude-haiku-4.5`
    .replaceAll(".", "-");

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

const plain = (md: string): string => md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

/**
 * Tags from words in the description itself, in this order (the more telling
 * first), at most four. Not our judgment of the model: a tag shows only when
 * its words are in the text. "flagship" is not a tag: it fired on
 * "near-frontier" and on mentions of another model.
 */
const TAG_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["deep reasoning", /\b(deep|demanding|complex|advanced|stronger|expert) reasoning\b|\bhard(est)? (tasks|problems)\b|\bdifficult\b/],
  ["long tasks", /\blong[- ](horizon|running|context)\b|\bmulti[- ]step\b/],
  ["everyday", /\beveryday\b|\bwell[- ]scoped\b|\bgeneral[- ]purpose\b/],
  ["fast", /\bfast(est)?\b|\blow[- ]latency\b|\bresponsive\b/],
  ["low cost", /\bcost[- ](efficient|sensitive|effective)\b|\baffordable\b|\bcheap\b|\bfraction of the cost\b|\befficient model\b/],
  ["high volume", /\bhigh[- ]volume\b|\bthroughput\b/],
  ["vision", /\bvision\b|\bvisual\b|\bmultimodal\b|\bimages?\b/],
  ["writing", /\bwriting\b|\bcreative\b/],
  ["research", /\bresearch\b|\banalysis\b/],
  ["summaries", /\bsummari[sz]/],
  ["chat", /\bchat\b|\bconversation/],
  ["coding", /\bcod(e|ing)\b|\bcodebases?\b|\bsoftware engineering\b|\bprogramming\b|\bbugs\b|\bfeatures\b/],
  ["agents", /\bagent(s|ic)?\b|\bsubagents\b|\btool[- ]use\b|\bcomputer use\b|\bbrowser use\b/],
];

/** Words about another model ("above the fast GPT-6 Luna", "succeeding Opus 5") are not about this one. */
const ABOUT_ANOTHER = /\b(below|above|than|unlike|succeed(s|ing)?|replac(es|ing)|building on|matching|compared (to|with))\b[^,.;]*/gi;

export function guideTags(text: string): string[] {
  const own = text.toLowerCase().replace(ABOUT_ANOTHER, " ");
  return TAG_WORDS.filter(([, words]) => words.test(own))
    .map(([tag]) => tag)
    .slice(0, 4);
}

const SHORT_MAX = 75;

/** "Claude Haiku 5.5 is Anthropic's small, fast model for…" → "Anthropic's small, fast model for…". */
export function shortLine(text: string): string {
  const first = (text.split(/(?<=[.!?])\s(?=[A-Z])/)[0] ?? "").trim();
  // Only a name goes: every word before " is " starts with a capital or digit
  // ("Claude Haiku 5.5", "GPT-6 Sol"), so "A fast model that is cheap" keeps its words.
  const named = first.match(/^(\S.{0,58}?) is (.+)$/);
  const isName = named?.[1]?.split(" ").every((w) => /^[A-Z0-9]/.test(w)) === true;
  const body = isName && named?.[2] ? named[2].charAt(0).toUpperCase() + named[2].slice(1) : first;
  if (body.length <= SHORT_MAX) return body;
  const cut = body.slice(0, SHORT_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut.slice(0, SHORT_MAX)).replace(/[,;:]$/, "")}…`;
}

interface RawEntry {
  id?: unknown;
  description?: unknown;
  knowledge_cutoff?: unknown;
  expiration_date?: unknown;
}

/** One guide per model. Junk in → {}. */
export function buildGuideIndex(api: unknown): GuideIndex {
  const data = (api as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return {};
  const index: GuideIndex = {};
  const fromOwnEntry = new Set<string>();
  for (const raw of data as RawEntry[]) {
    if (raw === null || typeof raw !== "object") continue;
    const id = str(raw.id);
    const text = str(raw.description);
    if (id === null || text === null || id.startsWith("~") || !SAFE_ID.test(id)) continue;
    const k = key(id);
    const own = !id.includes(":");
    // The model's own entry wins over a `:free` copy, in any order.
    if (index[k] !== undefined && (fromOwnEntry.has(k) || !own)) continue;
    const words = plain(text);
    index[k] = {
      text: words,
      tags: guideTags(words),
      short: shortLine(words),
      knowsUpTo: str(raw.knowledge_cutoff)?.slice(0, 7) ?? null,
      retiresOn: str(raw.expiration_date)?.slice(0, 10) ?? null,
      url: `https://openrouter.ai/${id}`,
    };
    if (own) fromOwnEntry.add(k);
  }
  return index;
}

export function lookupGuide(index: GuideIndex, id: string, opts: { tier?: boolean } = {}): ModelGuide | null {
  if (opts.tier === true) return null;
  const k = key(id);
  const found = index[k] ?? (AGY_SUFFIX.test(k) ? index[k.replace(AGY_SUFFIX, "")] : undefined);
  // The index may come from the saved file: re-check the link, fill what an older copy lacks.
  if (!found || typeof found.text !== "string" || typeof found.url !== "string") return null;
  if (!found.url.startsWith("https://openrouter.ai/")) return null;
  return {
    ...found,
    tags: Array.isArray(found.tags) ? found.tags : guideTags(found.text),
    short: typeof found.short === "string" ? found.short : shortLine(found.text),
  };
}

function readCache(home: string): { index: GuideIndex; fetchedAt: string | null } {
  const path = join(home, CACHE);
  if (!existsSync(path)) return { index: {}, fetchedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { index?: unknown; fetchedAt?: unknown };
    return {
      index: parsed.index && typeof parsed.index === "object" ? (parsed.index as GuideIndex) : {},
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
    };
  } catch {
    return { index: {}, fetchedAt: null };
  }
}

const defaultFetch = (): Promise<Response> => fetch(API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Same contract as `loadModelFacts`: fetch and save, or the saved copy marked offline. */
export async function loadModelGuides(
  home: string,
  fetchFn: () => Promise<Response> = defaultFetch,
  now: Date = new Date(),
  opts: { cachedOnly?: boolean } = {},
): Promise<LoadedGuides> {
  const saved = readCache(home);
  if (opts.cachedOnly === true) return { ...saved, offline: false, checked: false };
  try {
    const res = await fetchFn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const index = buildGuideIndex(await res.json());
    if (Object.keys(index).length === 0) throw new Error("no models in the reply");
    const fetchedAt = now.toISOString();
    atomicWrite(join(home, CACHE), `${JSON.stringify({ fetchedAt, index })}\n`);
    return { index, fetchedAt, offline: false };
  } catch {
    return { ...saved, offline: true };
  }
}
