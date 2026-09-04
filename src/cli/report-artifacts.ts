// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Artifact readers + their renderers for the static report HTML.
// Anything that loads a file from ~/.siltpoke/ or the repo tree and
// turns it into a panel lives here. Extracted from src/cli/report.ts
// (god-file split).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import type { I18nDict } from "./report-i18n";
import { fmt } from "./report-i18n";
import { esc, panelWrap } from "./report-dom";
import { readJsonl, type FeedbackRow } from "./report-panels";

export { renderProjectDetail } from "./report-project-detail";

interface DocFile {
  title: string;
  relativePath: string;
}

interface DocEntry {
  title: string;
  subtitle: string;
  relativePath: string;
}

const REPO_DOCS: DocEntry[] = [
  {
    title: "Manual",
    subtitle: "the usage manual — commands, config, troubleshooting",
    relativePath: "docs/MANUAL.md",
  },
  {
    title: "MBTI archetype mapping",
    subtitle: "fun reference — maps each Siltpoke archetype to its MBTI cousin",
    relativePath: "docs/ARCHETYPES.md",
  },
];

function repoRoot(): string {
  // src/cli/report-artifacts.ts → src/cli/ → src/ → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

export async function renderReferences(
  t: I18nDict,
  langIsEn: boolean,
): Promise<string> {
  const root = repoRoot();
  const renderedBlocks: string[] = [];
  for (const doc of REPO_DOCS) {
    const path = join(root, doc.relativePath);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const html = await marked.parse(raw);
    renderedBlocks.push(`
<details class="doc">
  <summary><span class="doc-title">${esc(doc.title)}</span><span class="muted small">${esc(doc.subtitle)}</span></summary>
  <article class="md">${html}</article>
</details>`);
  }
  if (renderedBlocks.length === 0) {
    return panelWrap(t.references, `<p class="muted">${esc(t.no_docs)}</p>`, false);
  }
  const note = langIsEn ? t.docs_note : `${t.docs_note} ${t.docs_english_note}`;
  return panelWrap(
    t.references,
    `<p class="muted small">${esc(note)}</p>${renderedBlocks.join("")}`,
    false,
  );
}

// ---------------------------------------------------------------------------
// New artifact renderers — show every readable file Siltpoke produces, so
// the user can browse all of it from the dashboard and decide what they
// actually want to keep.
// ---------------------------------------------------------------------------

export interface RawConfig {
  name?: string;
  species?: string;
  language?: string;
  snark?: number;
  patience?: number;
  rigor?: number;
  chattiness?: number;
  curiosity?: number;
  archetype?: string;
  personality_method?: "manual" | "quiz" | "memory" | "random";
  soul?: string;
  seedUsedAt?: string;
  rationale?: Partial<Record<"snark" | "patience" | "rigor" | "chattiness" | "curiosity", string>>;
  [k: string]: unknown;
}

export async function readRawConfig(homeBase: string): Promise<RawConfig | null> {
  const path = join(homeBase, "config.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch {
    return null;
  }
}

export function renderGenesis(cfg: RawConfig | null, t: I18nDict): string {
  if (!cfg) {
    return panelWrap(t.personality_genesis, `<p class="muted">${esc(t.no_genesis)}</p>`, false);
  }
  const method = cfg.personality_method ?? "manual";
  const methodDesc =
    method === "manual"
      ? t.method_manual
      : method === "quiz"
        ? t.method_quiz
        : method === "memory"
          ? t.method_memory
          : t.method_random;
  const dials: ReadonlyArray<keyof RawConfig> = [
    "snark",
    "patience",
    "rigor",
    "chattiness",
    "curiosity",
  ];
  const rationale = cfg.rationale ?? {};
  const hasRationale = Object.keys(rationale).length > 0;

  const rationaleRows = hasRationale
    ? dials
        .map((d) => {
          const value = cfg[d];
          const why = (rationale as Record<string, string>)[d as string] ?? "";
          return `<tr><td><strong>${esc(String(d))}</strong></td><td>${esc(String(value ?? ""))}</td><td>${esc(why)}</td></tr>`;
        })
        .join("")
    : "";

  const soulBlock = cfg.soul
    ? `<blockquote class="genesis-soul">${esc(cfg.soul)}</blockquote>`
    : "";

  const body = `
  <div class="kv-list">
    <div class="kv-row"><span class="kv-k">${esc(t.method_label)}</span><span class="kv-v">${esc(methodDesc)}</span></div>
    ${cfg.archetype ? `<div class="kv-row"><span class="kv-k">${esc(t.archetype_label)}</span><span class="kv-v"><strong>${esc(cfg.archetype)}</strong></span></div>` : ""}
    ${cfg.seedUsedAt ? `<div class="kv-row"><span class="kv-k">${esc(t.generated_at)}</span><span class="kv-v">${esc(cfg.seedUsedAt)}</span></div>` : ""}
  </div>
  ${soulBlock ? `<div class="kv-k" style="margin-top:1rem">${esc(t.soul_label)}</div>${soulBlock}` : ""}
  ${
    hasRationale
      ? `<div class="kv-k" style="margin-top:1rem">${esc(t.rationale_label)}</div>
         <table class="dense">
           <thead><tr><th>${esc(t.dial_col)}</th><th>${esc(t.value_col)}</th><th>${esc(t.why_col)}</th></tr></thead>
           <tbody>${rationaleRows}</tbody>
         </table>`
      : method === "manual"
        ? `<p class="muted small" style="margin-top:0.75rem">${esc(t.no_genesis)}</p>`
        : ""
  }`;
  return panelWrap(t.personality_genesis, body, !cfg.personality_method || cfg.personality_method !== "manual");
}

export interface RawProgression {
  level?: number;
  xp?: number;
  xp_to_next_level?: number;
  unlocked_poses?: string[];
  unlocked_titles?: string[];
  pet_log?: Array<{ day: string; count: number }>;
}

export async function readRawProgression(
  homeBase: string,
): Promise<RawProgression | null> {
  const path = join(homeBase, "progression.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawProgression;
  } catch {
    return null;
  }
}

export function renderProgressionDetail(
  prog: RawProgression | null,
  t: I18nDict,
): string {
  if (!prog) {
    return panelWrap(
      t.progression_detail,
      `<p class="muted">${esc(t.no_calls_yet)}</p>`,
      false,
    );
  }
  const petLog = (prog.pet_log ?? []).slice(-7);
  const petLogRows = petLog
    .map((d) => `<tr><td>${esc(d.day)}</td><td>${d.count}</td></tr>`)
    .join("");
  const titles = (prog.unlocked_titles ?? []).join(" · ") || "—";
  const poses = (prog.unlocked_poses ?? []).join(" · ") || "—";
  const todayKey = new Date().toISOString().slice(0, 10);
  const petsToday = petLog.find((d) => d.day === todayKey)?.count ?? 0;

  const body = `
  <div class="kv-list">
    <div class="kv-row"><span class="kv-k">${esc(t.current_xp)}</span><span class="kv-v"><strong>${prog.xp ?? 0}</strong> / ${prog.xp_to_next_level ?? 0} (${esc(t.level_short)} ${prog.level ?? 1})</span></div>
    <div class="kv-row"><span class="kv-k">${esc(t.titles_unlocked)}</span><span class="kv-v">${esc(titles)}</span></div>
    <div class="kv-row"><span class="kv-k">${esc(t.unlocked_poses_label)}</span><span class="kv-v">${esc(poses)}</span></div>
    <div class="kv-row"><span class="kv-k">${esc(t.pets_today_label)}</span><span class="kv-v">${petsToday} / 3</span></div>
  </div>
  ${
    petLogRows
      ? `<div class="kv-k" style="margin-top:1rem">${esc(t.pet_log_label)}</div>
         <table class="dense">
           <thead><tr><th>${esc(t.time_col)}</th><th>${esc(t.pets_today_label)}</th></tr></thead>
           <tbody>${petLogRows}</tbody>
         </table>`
      : ""
  }`;
  return panelWrap(t.progression_detail, body, false);
}

export function renderConfigPanel(
  cfg: RawConfig | null,
  t: I18nDict,
): string {
  const c = cfg ?? {};
  const dials: ReadonlyArray<"snark" | "patience" | "rigor" | "chattiness" | "curiosity"> = [
    "snark",
    "patience",
    "rigor",
    "chattiness",
    "curiosity",
  ];
  const languages: Array<[string, string]> = [
    ["en", "English"],
    ["zh-CN", "中文 (简体)"],
    ["zh-TW", "中文 (繁體)"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["es", "Español"],
    ["fr", "Français"],
    ["de", "Deutsch"],
  ];
  const speciesList: Array<[string, string]> = [
    ["slime", "slime"],
    ["cat", "cat"],
    ["owl", "owl"],
    ["robot", "robot"],
    ["bunny", "bunny"],
  ];
  // ⚠️ THIS CONTROL IS ON A RETIRED PAGE AND NO USER CAN REACH IT.
  // `buildReport` has no caller anywhere in `src/` (only tests), and
  // `src/daemon/server.ts` says "its legacy GET /dashboard report page is
  // retired". The LIVE review-unit control is
  // `src/web/screens/timeline/review-unit-row.tsx`, served at /timeline.
  // Editing the unit set here changes nothing a user sees, but it WILL red
  // the four `report.golden` fixtures — which is the only reason this note
  // exists, so nobody spends an afternoon on it. Removing this panel is a
  // separate decision about the retired page as a whole.
  //
  // Two units, not four modes (spec D8 / AC12). The old `triggerMode` values
  // are not offered — they all mean "commit" now, and offering a dead value as
  // a choice is how a control keeps promising something it cannot do.
  const reviewUnits: Array<[string, string]> = [
    ["commit", "commit"],
    ["pr", "pr"],
  ];

  const langOpts = languages
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${c.language === v ? " selected" : ""}>${esc(l)}</option>`,
    )
    .join("");
  const speciesOpts = speciesList
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${c.species === v ? " selected" : ""}>${esc(l)}</option>`,
    )
    .join("");
  // AC10 — a config still carrying any of the four old `triggerMode` values
  // renders as `commit` and does not error. The old key is NOT read as a
  // fallback here on purpose: mapping it in the UI would show a value this
  // control cannot write back, and AC11 says the old key is never rewritten.
  const reviewUnit =
    (c as Record<string, unknown>).reviewUnit === "pr" ? "pr" : "commit";
  const reviewUnitOpts = reviewUnits
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${reviewUnit === v ? " selected" : ""}>${esc(l)}</option>`,
    )
    .join("");

  const dialRows = dials
    .map((d) => {
      const v = typeof c[d] === "number" ? (c[d] as number) : 5;
      return `
      <div class="cfg-row cfg-dial">
        <label for="cfg-${esc(d)}" class="cfg-label">${esc(d)}</label>
        <input id="cfg-${esc(d)}" type="range" min="0" max="10" step="1" value="${v}" data-config-key="${esc(d)}" data-config-type="number" />
        <span class="cfg-val" data-config-display="${esc(d)}">${v}</span>
      </div>`;
    })
    .join("");

  // Always serve-mode. Static-only path is gone — `bun run report`
  // now boots the local server, so the form always has an Apply button
  // that writes config.json via /api/config.
  const note = t.config_note_serve;
  const applyBtn = `<button type="button" class="cfg-apply" id="cfg-apply">${esc(t.config_apply)}</button>`;

  const body = `
  <p class="muted small">${esc(note)}</p>
  <div class="cfg-grid">
    <div class="cfg-row">
      <label for="cfg-name" class="cfg-label">${esc(t.config_name)}</label>
      <input id="cfg-name" type="text" value="${esc(c.name ?? "")}" data-config-key="name" data-config-type="string" />
    </div>
    <div class="cfg-row">
      <label for="cfg-species" class="cfg-label">${esc(t.config_species)}</label>
      <select id="cfg-species" data-config-key="species" data-config-type="string">${speciesOpts}</select>
    </div>
    <div class="cfg-row">
      <label for="cfg-language" class="cfg-label">${esc(t.config_language)}</label>
      <select id="cfg-language" data-config-key="language" data-config-type="string">${langOpts}</select>
    </div>
    <div class="cfg-row">
      <label for="cfg-review-unit" class="cfg-label">${esc(t.config_review_unit)}</label>
      <select id="cfg-review-unit" data-config-key="reviewUnit" data-config-type="string">${reviewUnitOpts}</select>
    </div>
    <div class="cfg-divider"></div>
    ${dialRows}
  </div>
  <div class="cfg-diff" id="cfg-diff">
    <div class="cfg-diff-header">
      <span id="cfg-diff-label" class="muted small">${esc(t.config_no_changes)}</span>
      <div class="cfg-actions">
        <button type="button" class="cfg-reset" id="cfg-reset">${esc(t.config_reset)}</button>
        ${applyBtn}
      </div>
    </div>
    <span id="cfg-toast" class="cfg-toast" hidden>${esc(t.config_copied)}</span>
  </div>`;
  return `
<details class="panel cfg-panel" open>
  <summary><h2>${esc(t.config_title)}</h2></summary>
  <div class="panel-body">${body}</div>
</details>`;
}

export async function renderErrorLog(homeBase: string, t: I18nDict): Promise<string> {
  const path = join(homeBase, "logs", "errors.log");
  if (!existsSync(path)) {
    return panelWrap(t.error_log, `<p class="muted">${esc(t.no_errors)}</p>`, false);
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return panelWrap(t.error_log, `<p class="muted">${esc(t.no_errors)}</p>`, false);
  }
  const tail = raw.split("\n").filter((l) => l.trim()).slice(-30).join("\n");
  if (!tail) {
    return panelWrap(t.error_log, `<p class="muted">${esc(t.no_errors)}</p>`, false);
  }
  return panelWrap(
    t.error_log,
    `<p class="muted small">${esc(fmt(t.last_n, { n: "30" }))}</p><pre><code>${esc(tail)}</code></pre>`,
    false,
  );
}
