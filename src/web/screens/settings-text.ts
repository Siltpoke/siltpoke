// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The Settings page's words, apart from its markup: what each chip, role row
 * and cap line says. The screen renders with these, and `settingsPageText`
 * puts the same words in plain text for dashboard chat's page context — so
 * chat reads what the page shows, not a second account of it (chat on
 * Settings once answered "I need more context").
 */
import type { PerRole } from "../../brain/daily-caps-view";
import { codexOwnModelText } from "../../brain/model-window";
import { type BrainRoleView, type BrainView, sourceIsExplicitPin } from "../../cli/brain-cli";
import type { InUse, PickerRole } from "../client/islands/model-picker";
import type { LastCall } from "./settings-last-calls";

interface SettingsFacts {
  view: BrainView;
  /** Each role's daily cap and its calls today (the counter the cap checks). */
  caps: { caps: PerRole; usage: PerRole };
  /** What the records say happened last — never the current setting. */
  last: { chat: LastCall | null; review: LastCall | null };
  now: Date;
  /** The model codex's own config sets, if any (`readCodexConfigModel`). */
  codexModel?: string;
}

export const PAGE_TITLE = "Agents";
export const PAGE_LEAD = "Which coding agent you build with, and which ones Siltpoke uses for its own work.";

const pad = (n: number): string => String(n).padStart(2, "0");

/** `19:58` when it is today on this machine, else `2026-10-13 19:58`. */
export function when(iso: string | null, now: Date): string | null {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

const ROLES: readonly PickerRole[] = ["chat", "review", "extract"];

/** What each role is called on the page, and what it does. */
export const ROLE_COPY: Record<PickerRole, { name: string; does: string }> = {
  chat: { name: "Chat", does: "answers you in the dashboard chat" },
  review: { name: "Critic", does: "reviews your code after each turn" },
  extract: { name: "Summarizer", does: "writes summaries and extracts memories" },
};

/** Never the builder's model by name: Siltpoke does not know it (§12.1). */
const DEFAULT_WHY = "Siltpoke's default — does not copy the model you use yourself";

/** Why a role uses what it uses, from its config source. */
const SOURCE_WHY: Record<string, string> = {
  "pinned here": "you chose it",
  "env override": "set by SILTPOKE_REVIEWER_PROVIDER",
  reviewer_provider: "set by reviewer_provider in config.json",
};

/** What an agent's chip says after its name: building and when, installed, or not installed. */
export function chipText(a: BrainView["agents"][number], now: Date): string {
  const seen = when(a.seenAt, now);
  return seen !== null ? `building · ${seen}` : a.installed ? "installed" : "not installed";
}

/** When the agent did not say which model answered: name what was asked for
 * (if the record kept it) and say plainly that the agent did not report the
 * rest — "model not reported" alone read as a Siltpoke fault. */
function unreported(c: SettingsFacts["last"]["chat"] & object): string {
  const agent = c.family ?? "an unnamed agent";
  return c.requested !== null && c.requested.length > 0
    ? `Settings chose ${c.requested}; ${agent} did not report which model it actually used`
    : `${agent} did not report which model it used`;
}

/** The line under a role row: what its last recorded call was. */
export function lastLine(role: PickerRole, last: SettingsFacts["last"], now: Date): string {
  if (role === "chat") {
    const c = last.chat;
    if (c === null) return "no answer recorded yet";
    const at = when(c.at, now) ?? "an unknown time";
    if (c.family === null) return `last chat call: no agent was decided at ${at}`;
    if (c.outcome === "failed") return `last chat call failed: ${c.family} at ${at}`;
    if (c.outcome === "cancelled") return `last chat call was stopped: ${c.family} at ${at}`;
    if (c.model !== null) return `last answer: ${c.family} · ${c.model} at ${at}`;
    return `last answer: ${c.family} at ${at} · ${unreported(c)}`;
  }
  if (role === "review") {
    const r = last.review;
    if (r === null) return "no review recorded yet";
    const agent = r.family ?? "an unnamed agent";
    const at = when(r.at, now) ?? "an unknown time";
    return r.model !== null ? `last review: ${agent} · ${r.model} at ${at}` : `last review: ${agent} at ${at} · ${unreported(r)}`;
  }
  // No per-call record exists for the summarizer today (spec §4, §7.1 [4]).
  return "no summarizer call is recorded yet";
}

interface Using {
  /** null = no agent (chat will ask, or none is installed). */
  family: string | null;
  /** Big text: the agent, or what stands in for it. */
  head: string;
  modelText: string;
  why: string;
  inUse: InUse;
}

function modelText(family: string, model: string | undefined, codexModel: string | undefined): string {
  if (model) return model;
  return family === "codex" ? codexOwnModelText(codexModel) : "its own default model";
}

/** An agent on its own model: the row's words, handed to the window for its bar. */
function ownModel(family: string, model: string | undefined, codexModel: string | undefined): { modelText?: string } {
  return model ? {} : { modelText: modelText(family, model, codexModel) };
}

/** What a role uses now and why — the row's "Using" cell and the window's bar. */
function using(view: BrainView, r: BrainRoleView, codexModel: string | undefined): Using {
  if (r.role === "chat") {
    const c = view.chat;
    if (c.kind === "choose" || c.kind === "none") {
      const head = c.kind === "choose" ? "not chosen" : "no coding agent installed";
      const sub = c.kind === "choose" ? "chat will ask which agent" : "";
      return { family: null, head, modelText: sub, why: "", inUse: { family: "", model: "", why: head, isDefault: false } };
    }
    const why = c.source === "chosen" ? "you chose it" : "the only agent installed";
    return {
      family: c.family,
      head: c.family,
      modelText: modelText(c.family, c.model, codexModel),
      why,
      inUse: { family: c.family, model: c.model ?? "", why, isDefault: false, ...ownModel(c.family, c.model, codexModel) },
    };
  }
  const isDefault = !sourceIsExplicitPin(r.source);
  // An unpinned critic is not claude: the hook reviews with the agent the user
  // builds with, or that agent's per-builder rule (brain-config: review_by_builder
  // ?? host family). This process has no host, so its own resolution would lie.
  if (r.role === "review" && isDefault) {
    const label = "the agent you build with";
    return {
      family: null,
      head: label,
      modelText: "on its own default model, or the rule set for that agent",
      why: DEFAULT_WHY,
      inUse: { family: "", model: "", why: DEFAULT_WHY, isDefault: true, label },
    };
  }
  const why = isDefault ? DEFAULT_WHY : (SOURCE_WHY[r.source] ?? r.source);
  return {
    family: r.family,
    head: r.family,
    modelText: modelText(r.family, r.model, codexModel),
    why,
    inUse: { family: r.family, model: r.model ?? "", why, isDefault, ...ownModel(r.family, r.model, codexModel) },
  };
}

/** Each role's row, as the page resolves it. */
export function roleRows(view: BrainView, codexModel?: string): Array<{ role: PickerRole; u: Using }> {
  return ROLES.map((role) => {
    const r: BrainRoleView = view.roles.find((x) => x.role === role) ?? { role, family: "claude", source: "default" };
    return { role, u: using(view, r, codexModel) };
  });
}

/** The page in plain text, for dashboard chat. */
export function settingsPageText({ view, caps, last, now, codexModel }: SettingsFacts): string {
  const chips = view.agents.map((a) => `- ${a.family} — ${chipText(a, now)}`);
  const rows = roleRows(view, codexModel).map(({ role, u }) => {
    const { name, does } = ROLE_COPY[role];
    const what = [u.head, u.modelText].filter(Boolean).join(", ");
    const cap = caps.caps[role];
    const capText = cap === 0 ? "no daily cap" : `daily cap ${cap}`;
    const why = u.why ? ` — ${u.why}` : "";
    return `- ${name} (${does}): ${what}${why}. ${capText}, ${caps.usage[role]} used today. ${lastLine(role, last, now)}.`;
  });
  return [
    `${PAGE_TITLE} — ${PAGE_LEAD}`,
    "",
    "Coding agents on this machine (seen by Siltpoke, not a setting; building = a session was seen, with when):",
    ...chips,
    "",
    "Siltpoke's own agents:",
    ...rows,
    "",
    "Each row's daily cap field saves when the field is left (0 = no cap). Change model opens a window listing every agent's models with models.dev prices; Use there sets that role's agent and model.",
  ].join("\n");
}
