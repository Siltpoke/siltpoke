// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * action-result island.
 *
 * Listens for the `action-result` CustomEvent that HTMX fires when the server
 * includes an `HX-Trigger` header on POST /api/action.
 *
 * On receipt:
 *   1. Merges identity fields (level/mood/name/species) into the $pet store.
 *   2. Bumps the sprite + scatters action emoji + shows a stat delta banner
 *      so the click feels alive.
 *
 * Listener is on `window` so it survives outerHTML swap of #hero.
 *
 * Security: payload values come from a server-computed JSON blob embedded
 * in an HTTP header. Mood + species narrowed at runtime against an allowlist
 * before merging. action narrowed against a static set. Stat-delta keys are
 * looked up via a fixed Record so unknown keys silently drop.
 */
import { setPet } from "../stores/petState";
import type { Pet } from "../stores/petState";

type StatKey = "hp" | "hunger" | "energy" | "mood" | "bond";

interface ActionResultPayload {
  level?: number;
  mood?: string;
  name?: string;
  species?: string;
  action?: string;
  awarded?: number;
  capped?: boolean;
  grumpy?: boolean;
  stat_delta?: Partial<Record<StatKey, number>>;
}

const VALID_MOODS: readonly Pet["mood"][] = [
  "neutral", "happy", "sleepy", "sad", "hungry", "poke", "snark", "wow",
];

const VALID_SPECIES: readonly Pet["species"][] = [
  "cat", "bunny", "robot", "bun", "otter", "alien", "slime", "crab",
];

const VALID_ACTIONS = new Set([
  "feed", "play", "pet", "clean", "sleep", "tease",
]);

const STAT_LABEL: Record<StatKey, string> = {
  hp: "hp", hunger: "hunger", energy: "energy", mood: "mood", bond: "bond",
};

const STAT_COLOR: Record<StatKey, string> = {
  hp: "#c75c5c", hunger: "#d97a3a", energy: "#7aa757",
  mood: "#c75c5c", bond: "#5a96c8",
};

/**
 * Glyphs scattered per action. Multiple distinct symbols per action makes
 * each click feel different even when the sprite mood overlaps.
 */
const ACTION_GLYPHS: Record<string, readonly string[]> = {
  feed:  ["🍖", "🍗", "🥩", "🍤", "✨"],
  pet:   ["♥", "♡", "✨", "💕", "♥"],
  play:  ["✦", "★", "⚡", "✸", "✺"],
  clean: ["✨", "💧", "○", "·", "✨"],
  sleep: ["z", "Z", "z", "·", "Z"],
  tease: ["!", "?!", "✖", "!", "!"],
};

const ACTION_COLOR: Record<string, string> = {
  feed: "#d97a3a", pet: "#c75c5c", play: "#7aa757",
  clean: "#5a96c8", sleep: "#1f1b16", tease: "#c75c5c",
};

function isMood(v: string): v is Pet["mood"] {
  return (VALID_MOODS as readonly string[]).includes(v);
}

function isSpecies(v: string): v is Pet["species"] {
  return (VALID_SPECIES as readonly string[]).includes(v);
}

/**
 * Bump the sprite once. .pet-bump overrides the idle .pet-float animation,
 * so we MUST remove the class after the bump finishes — otherwise the float
 * never resumes and the sprite sits frozen until next reload.
 */
const BUMP_DURATION_MS = 520;
function bumpSprite(): void {
  const sprite = document.querySelector(".pet-float") as HTMLElement | null;
  if (!sprite) return;
  sprite.classList.remove("pet-bump");
  // Force reflow so re-adding the class restarts the animation.
  void sprite.offsetWidth;
  sprite.classList.add("pet-bump");
  setTimeout(() => sprite.classList.remove("pet-bump"), BUMP_DURATION_MS);
}

/**
 * Scatter 5 glyphs around the sprite. Each glyph gets a random x-offset and
 * slight delay so they don't all overlap. Removed after the animation.
 */
function scatterGlyphs(action: string): void {
  const host = document.querySelector(".home-center__creature") as HTMLElement | null;
  if (!host) return;
  const glyphs = ACTION_GLYPHS[action];
  const color = ACTION_COLOR[action] ?? "#1f1b16";
  if (!glyphs) return;

  for (let i = 0; i < glyphs.length; i++) {
    const g = document.createElement("span");
    g.className = "action-scatter";
    g.setAttribute("aria-hidden", "true");
    g.textContent = glyphs[i]!;
    // Random horizontal offset (-90 to +90 px), small vertical jitter,
    // staggered delay so they spray out.
    const x = (Math.random() * 180 - 90).toFixed(0);
    const yStart = (Math.random() * 30 - 10).toFixed(0);
    const rot = (Math.random() * 60 - 30).toFixed(0);
    const delay = (i * 80).toFixed(0);
    g.style.cssText = [
      "position:absolute",
      `left:calc(50% + ${x}px)`,
      `top:calc(45% + ${yStart}px)`,
      "transform:translate(-50%,0)",
      "pointer-events:none",
      "font-size:24px",
      "font-family:'JetBrains Mono', ui-monospace, monospace",
      "font-weight:700",
      `color:${color}`,
      "z-index:5",
      "opacity:0",
      `animation:siltpokeScatter 1400ms cubic-bezier(.2,.7,.3,1) ${delay}ms forwards`,
      `--scatter-rot:${rot}deg`,
    ].join(";");
    host.appendChild(g);
    setTimeout(() => g.remove(), 1500 + i * 80);
  }
}

/**
 * Banner overlay at top of #hero showing what changed. Lists awarded XP +
 * stat deltas as small chips. Auto-dismisses after 2.4s.
 */
function showBanner(payload: ActionResultPayload): void {
  const hero = document.querySelector("#hero") as HTMLElement | null;
  if (!hero) return;

  // Remove any prior banner so rapid clicks don't stack.
  hero.querySelectorAll(".action-banner").forEach((n) => n.remove());

  const action = payload.action ?? "";
  const awarded = typeof payload.awarded === "number" ? payload.awarded : 0;
  const capped = payload.capped === true;
  const grumpy = payload.grumpy === true;
  const deltas = (payload.stat_delta ?? {}) as Partial<Record<StatKey, number>>;
  const color = ACTION_COLOR[action] ?? "#1f1b16";

  const banner = document.createElement("div");
  banner.className = "action-banner";
  banner.setAttribute("role", "status");
  banner.style.cssText = [
    "position:absolute",
    "top:56px",
    "left:50%",
    "transform:translate(-50%,-8px)",
    "padding:6px 12px",
    "background:#faf6ec",
    `border:1px solid ${color}`,
    "border-radius:10px",
    "box-shadow:0 4px 12px rgba(31,27,22,0.10)",
    "display:flex",
    "gap:8px",
    "align-items:center",
    "font-family:'JetBrains Mono', ui-monospace, monospace",
    "font-size:12px",
    "color:#1f1b16",
    "z-index:6",
    "opacity:0",
    "animation:siltpokeBanner 2400ms ease-out forwards",
    "white-space:nowrap",
  ].join(";");

  // Title chip — capitalize the action.
  const title = document.createElement("span");
  title.textContent = action;
  title.style.cssText = `color:${color};font-weight:700;text-transform:lowercase`;
  banner.appendChild(title);

  // Stat-delta chips. Stats always apply now; `capped` means XP plateau hit.
  const chips: string[] = [];
  for (const k of ["hp", "hunger", "energy", "mood", "bond"] as StatKey[]) {
    const v = deltas[k];
    if (typeof v !== "number" || v === 0) continue;
    const sign = v > 0 ? "+" : "";
    const c = STAT_COLOR[k];
    chips.push(`<span style="color:${c};font-weight:600">${sign}${v} ${STAT_LABEL[k]}</span>`);
  }
  if (awarded > 0) {
    chips.push(`<span style="color:#c75c5c;font-weight:700">+${awarded} XP</span>`);
  }
  if (capped && awarded === 0) {
    chips.push(`<span style="color:#8a7c64">XP capped today</span>`);
  } else if (capped) {
    chips.push(`<span style="color:#8a7c64">XP cap reached</span>`);
  }
  if (grumpy && awarded === 1) {
    chips.push(`<span style="color:#8a7c64">grumpy</span>`);
  }
  const chipBox = document.createElement("span");
  chipBox.style.cssText = "display:flex;gap:8px";
  chipBox.innerHTML = chips.join("");
  banner.appendChild(chipBox);

  hero.appendChild(banner);
  setTimeout(() => banner.remove(), 2500);
}

window.addEventListener("action-result", (evt: Event) => {
  const detail = (evt as CustomEvent<ActionResultPayload>).detail;
  if (!detail || typeof detail !== "object") return;

  const patch: Partial<Pet> = {};
  if (typeof detail.level === "number") patch.level = detail.level;
  if (typeof detail.mood === "string" && isMood(detail.mood)) {
    patch.mood = detail.mood;
  }
  if (typeof detail.name === "string") patch.name = detail.name;
  if (typeof detail.species === "string" && isSpecies(detail.species)) {
    patch.species = detail.species;
  }
  setPet(patch);

  if (typeof detail.action === "string" && VALID_ACTIONS.has(detail.action)) {
    bumpSprite();
    scatterGlyphs(detail.action);
    showBanner(detail);
  }
});
