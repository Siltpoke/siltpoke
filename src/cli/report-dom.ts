// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// DOM / chrome rendering helpers for the static report HTML.
// Extracted from src/cli/report.ts (god-file split).

import type { CardResult } from "./card";
import type { I18nDict } from "./report-i18n";
import { getSpecies } from "../face/species";
import { resolveArt } from "../state/pose";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JSON-stringify a value for embedding inside an inline <script> body.
 * Plain JSON.stringify can leak `</script>` early-close and lets raw
 * markup-looking substrings (like "<img src=x>") appear verbatim in the
 * HTML, which trips the XSS audit test even though it's inert.
 * We escape all HTML-meaningful chars to their \uXXXX form.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>\u0026\u0027\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function severityClass(sev: string): string {
  if (sev === "high") return "sev-high";
  if (sev === "medium") return "sev-medium";
  if (sev === "low") return "sev-low";
  return "sev-info";
}

/**
 * Every right-column section uses <details> so the user can collapse or
 * expand individually. The first call to each section can pass
 * defaultOpen=true (for headline panels like Today / Last 7 days /
 * Projects / Pending) and the rest stay closed by default.
 */
export function panelWrap(title: string, body: string, defaultOpen: boolean): string {
  return `
<details class="panel"${defaultOpen ? " open" : ""}>
  <summary><h2>${esc(title)}</h2></summary>
  <div class="panel-body">${body}</div>
</details>`;
}

export function moodEmoji(mood: string): string {
  const map: Record<string, string> = {
    happy: "(◕‿◕)",
    excited: "(★‿★)",
    annoyed: "(╯°□°)╯",
    concerned: "(´д｀)",
    watching: "( •_•)",
    tired: "(´-ω-`)",
    idle: "( ´ ▽ ` )",
    sleeping_quiet: "(-_-) zzz",
    sleeping_broke: "($_$) broke",
  };
  return map[mood] ?? "(o.o)";
}

export function renderPetShell(card: CardResult, t: I18nDict): string {
  const species = getSpecies(card.species);
  const art = resolveArt(species, card.mood);
  const xpPct = Math.min(
    100,
    Math.round((card.xp / Math.max(1, card.xp_to_next_level)) * 100),
  );
  return `
<aside class="shell">
  <div class="shell-loop"></div>
  <div class="shell-body">
    <div class="shell-top">
      <div class="shell-dots"><span></span><span></span><span></span></div>
      <div class="shell-brand">SILTPOKE · ${esc(t.level_short)} ${card.level}</div>
    </div>
    <div class="lcd-frame">
      <div class="lcd">
        <div class="scanlines"></div>
        <div class="heart-burst" id="heart-burst" aria-hidden="true"></div>
        <div class="pet-portrait" id="pet-portrait" aria-hidden="true">${esc(art)}</div>
        <div class="pet-name">${esc(card.name)}<span class="muted"> · ${esc(card.species)}</span></div>
        <div class="pet-mood">${esc(moodEmoji(card.mood))}</div>
        <div class="bubble" id="bubble">${card.bubble ? `<span class="bubble-quote">&ldquo;</span><span id="bubble-text">${esc(card.bubble)}</span><span class="bubble-quote">&rdquo;</span>` : `<span class="muted" id="bubble-text">${esc(t.quiet)}</span>`}</div>
        <div class="meters">
          <div class="meter-row">
            <span class="meter-label">${esc(t.xp)}</span>
            <div class="meter"><div class="fill" style="width:${xpPct}%"></div></div>
            <span class="meter-val">${card.xp}/${card.xp_to_next_level}</span>
          </div>
          <div class="meter-row">
            <span class="meter-label">${esc(t.calls_label)}</span>
            <div class="meter"><div class="fill" style="width:${Math.min(100, card.brain_calls_today * 10)}%"></div></div>
            <span class="meter-val">${card.brain_calls_today}</span>
          </div>
          <div class="meter-row">
            <span class="meter-label">${esc(t.spend_label)}</span>
            <div class="meter"><div class="fill" style="width:${Math.min(100, Math.round(card.cost_today_usd * 1000))}%"></div></div>
            <span class="meter-val">$${card.cost_today_usd.toFixed(4)}</span>
          </div>
        </div>
        <div class="titles">${esc(card.titles.join(" · ") || t.no_titles)}</div>
      </div>
    </div>
    <div class="shell-buttons">
      <button class="btn" data-action="feed" type="button" aria-label="feed"><span class="btn-glyph">A</span></button>
      <button class="btn" data-action="play" type="button" aria-label="play"><span class="btn-glyph">B</span></button>
      <button class="btn" data-action="tease" type="button" aria-label="tease"><span class="btn-glyph">C</span></button>
    </div>
  </div>
</aside>`;
}
