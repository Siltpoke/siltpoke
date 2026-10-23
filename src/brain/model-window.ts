// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What the Change-model window shows (spec §12.2): every agent's models with
 * their models.dev facts, and one line per source — models.dev and each agent
 * — saying whether it answered. A source that failed never stops the others:
 * its saved list is shown and its line says so.
 *
 * codex: besides its listed models (each choosable — Siltpoke passes `-m`), a
 * first row stands for "no model chosen": codex runs the model its own config
 * sets. It is the way back from a chosen model (review 2026-10-16), so it stays
 * now that codex takes `-m`.
 */
import { FAMILIES, type ProviderFamily } from "./brain-config";
import { type LoadedGuides, lookupGuide, type ModelGuide } from "./model-guides";
import type { ModelEntry, ModelLists } from "./model-lists";
import { type LoadedFacts, lookupFacts } from "./model-prices";
import { FAMILY_ACCEPTS_MODEL } from "./provider";

export interface ModelRow {
  /** "" = the agent's own configured model (codex). */
  id: string;
  family: ProviderFamily;
  description: string | null;
  tier: boolean;
  input: number | null;
  output: number | null;
  tags: string[];
  /** The maker's one-line description on models.dev; null = none (a tier, an unknown model). */
  about: string | null;
  /** OpenRouter's account of the model (what it is for, cutoff, retirement, page); null = not listed there. */
  guide: ModelGuide | null;
  /** false = listed for its facts only: the agent cannot be handed this model. */
  choosable: boolean;
}

export interface SourceLine {
  name: string;
  ok: boolean;
  text: string;
}

export interface ModelWindowView {
  /** The day the saved lists are from (YYYY-MM-DD); null = never fetched. */
  savedOn: string | null;
  rows: ModelRow[];
  sources: SourceLine[];
}

/** What codex runs on, said one way everywhere: the page row, the window, chat. */
export function codexOwnModelText(configModel: string | undefined): string {
  return configModel ? `${configModel}, from codex's config` : "model set in codex's own config";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** A date as this machine's calendar day: `2026-10-15`. */
const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** The day a list was saved, in this machine's time — the first 10 characters
 * of the ISO string are UTC's day, a day ahead on a California evening.
 * A bare `YYYY-MM-DD` is already a day. */
const day = (iso: string | null): string | null => {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDay(d);
};
/** When a source last answered, in this machine's time: `2026-10-15 09:12`. */
const stamp = (iso: string | null): string => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** " 2026-10-15 09:12", or "" when the time is not known (no trailing space). */
const at = (iso: string | null): string => {
  const s = stamp(iso);
  return s ? ` ${s}` : "";
};
const models = (n: number): string => `${n} model${n === 1 ? "" : "s"}`;

function factsLine(facts: LoadedFacts): SourceLine {
  const saved = day(facts.fetchedAt);
  // The window's first read uses the saved copy and does not ask models.dev:
  // it must not claim models.dev answered.
  if (facts.checked === false) {
    return saved
      ? { name: "models.dev", ok: true, text: `models.dev — prices saved ${saved}` }
      : { name: "models.dev", ok: false, text: "models.dev — not checked yet" };
  }
  if (!facts.offline) return { name: "models.dev", ok: true, text: `models.dev — prices updated${at(facts.fetchedAt)}` };
  return {
    name: "models.dev",
    ok: false,
    text: saved ? `models.dev — not reached; showing prices saved ${saved}` : "models.dev — not reached; no prices yet",
  };
}

function agentLine(family: ProviderFamily, lists: ModelLists, facts: LoadedFacts): SourceLine {
  const l = lists.families[family];
  if (family === "claude" && facts.claudeModels.length > 0) {
    return { name: family, ok: true, text: `claude — ${models(facts.claudeModels.length)}` };
  }
  if (family === "claude") {
    return { name: family, ok: true, text: `claude — ${models(l.entries.length)} (hand list, ${l.fetchedAt})` };
  }
  if (l.error !== null) {
    const savedOn = day(l.fetchedAt);
    const saved = l.entries.length > 0 ? `; showing the list saved ${savedOn ?? "earlier"}` : "";
    return { name: family, ok: false, text: `${family} — ${l.error}${saved}` };
  }
  if (l.fetchedAt === null) return { name: family, ok: false, text: `${family} — not asked yet` };
  return { name: family, ok: true, text: `${family} — ${models(l.entries.length)}` };
}

/**
 * A family's models. claude has no list command: Anthropic's own list on
 * models.dev stands in for one, and the hand list only when models.dev was
 * never reached.
 */
function entriesFor(family: ProviderFamily, lists: ModelLists, facts: LoadedFacts): ModelEntry[] {
  if (family === "claude" && facts.claudeModels.length > 0) {
    return facts.claudeModels.map((id) => ({ id, family, description: null, tier: false }));
  }
  return lists.families[family].entries;
}

function guidesLine(g: LoadedGuides): SourceLine {
  const saved = day(g.fetchedAt);
  const name = "openrouter.ai";
  if (g.checked === false) {
    return saved
      ? { name, ok: true, text: `${name} — descriptions saved ${saved}` }
      : { name, ok: false, text: `${name} — not checked yet` };
  }
  if (!g.offline) return { name, ok: true, text: `${name} — descriptions updated${at(g.fetchedAt)}` };
  return {
    name,
    ok: false,
    text: saved ? `${name} — not reached; showing descriptions saved ${saved}` : `${name} — not reached; no descriptions yet`,
  };
}

export function modelWindowView(
  lists: ModelLists,
  facts: LoadedFacts,
  opts: { codexConfigModel?: string; guides?: LoadedGuides; now?: Date } = {},
): ModelWindowView {
  // This machine's date, not UTC's: a California evening is already tomorrow in UTC.
  const now = opts.now ?? new Date();
  const today = localDay(now);
  const guideOf = (id: string, tier: boolean): ModelGuide | null =>
    opts.guides ? lookupGuide(opts.guides.index, id, { tier }) : null;
  const rows: ModelRow[] = [];
  for (const family of FAMILIES) {
    const choosable = FAMILY_ACCEPTS_MODEL[family];
    if (family === "codex") {
      // This row IS the configured model, so it carries that model's facts.
      const own = opts.codexConfigModel ? lookupFacts(facts.index, opts.codexConfigModel, { tier: false }) : null;
      rows.push({
        id: "",
        family,
        description: codexOwnModelText(opts.codexConfigModel),
        tier: false,
        input: own?.input ?? null,
        output: own?.output ?? null,
        tags: own?.tags ?? [],
        about: own?.description ?? null,
        guide: opts.codexConfigModel ? guideOf(opts.codexConfigModel, false) : null,
        choosable: true,
      });
    }
    for (const entry of entriesFor(family, lists, facts)) {
      const guide = guideOf(entry.id, entry.tier);
      // Past its retirement day the model no longer answers: not worth a row.
      if (guide?.retiresOn && guide.retiresOn < today) continue;
      const f = lookupFacts(facts.index, entry.id, { tier: entry.tier });
      rows.push({
        ...entry,
        input: f?.input ?? null,
        output: f?.output ?? null,
        tags: f?.tags ?? [],
        about: f?.description ?? null,
        guide,
        choosable,
      });
    }
  }
  return {
    savedOn: day(lists.fetchedAt),
    rows,
    sources: [
      factsLine(facts),
      ...(opts.guides ? [guidesLine(opts.guides)] : []),
      ...FAMILIES.map((f) => agentLine(f, lists, facts)),
    ],
  };
}

