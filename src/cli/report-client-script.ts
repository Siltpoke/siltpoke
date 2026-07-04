// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Client-side <script> block embedded in the static report HTML.
// Extracted from src/cli/report.ts (god-file split).
//
// Drives: pet-action buttons (feed/play/tease) → /api/action,
// tab navigation w/ localStorage persistence, config form diff/apply.

import type { I18nDict } from "./report-i18n";
import { jsonForScript } from "./report-dom";
import type { RawConfig } from "./report-artifacts";

export interface ClientScriptInputs {
  species: string;
  rawCfg: RawConfig | null;
  t: I18nDict;
}

export function buildClientScript({ species, rawCfg, t }: ClientScriptInputs): string {
  return `<script>
    (function () {
      const bubbleText = document.getElementById("bubble-text");
      const bubble = document.getElementById("bubble");
      const portrait = document.getElementById("pet-portrait");
      const heartBurst = document.getElementById("heart-burst");
      const species = ${jsonForScript(species)};

      // Per-species action emoji. Stays in the JS bundle so we don't have
      // to round-trip to the server for "what does feeding a slime look
      // like".
      const FEED_EMOJI = ${jsonForScript({ slime: "🍩", cat: "🐟", owl: "🐭", robot: "🔋", bunny: "🥕" })};
      const PLAY_EMOJI = ${jsonForScript({ slime: "🎈", cat: "🧶", owl: "🎵", robot: "⚙️", bunny: "🥎" })};
      const TEASE_EMOJI = "💢";

      // mood overlay shown next to the pet portrait during the action
      const MOOD_EMOJI = { feed: "😋", play: "✨", tease: "😠" };

      // Big-face kaomoji swap. The ASCII portrait IS the pet — the small
      // mood emoji below it isn't enough. Each species gets its own
      // 3-line face per action so eating/playing/teased actually reads
      // on the screen the user is looking at.
      const ACTION_FACES = ${jsonForScript({
        cat: {
          feed: " /\\_/\\ \n(=^.^=)\n c♥♥♥o",
          play: " /\\_/\\ \n(=ↀωↀ=)\n c--o-o",
          tease: " /\\_/\\ \n(=>﹏<=)\n  ψ ψ ",
        },
        slime: {
          feed: " .---. \n (^ω^) \n (___) ",
          play: " .---. \n (>w<) \n (^v^) ",
          tease: " .---. \n (>口<)\n (___) ",
        },
        owl: {
          feed: " ,-,-, \n (˘ᴗ˘) \n ===== ",
          play: " ,-,-, \n (◉‿◉) \n ===== ",
          tease: " ,-,-, \n (•̀д•́)\n ===== ",
        },
        robot: {
          feed: " [---] \n |^v^| \n [___] ",
          play: " [---] \n |◉◡◉| \n [___] ",
          tease: " [---] \n |✗_✗| \n [___] ",
        },
        bunny: {
          feed: " (\\_/) \n (^ω^) \n (=v=) ",
          play: " (\\_/) \n (>v<) \n (=v=) ",
          tease: " (\\_/) \n (>_<) \n (=v=) ",
        },
      })};

      let serveMode = false;
      // Probe the local server. If it's there we wire mutating actions to
      // the API; otherwise we still play animations (visual-only).
      fetch("/api/ping", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data && data.ok) serveMode = true; })
        .catch(function () { /* static snapshot, no server */ });

      function showToast(msg, kind) {
        const t = document.getElementById("xp-toast");
        if (!t) return;
        t.textContent = msg;
        t.className = "xp-toast " + (kind || "");
        t.hidden = false;
        setTimeout(function () { t.hidden = true; }, 2400);
      }

      function spawnOverlayEmoji(emoji, count) {
        if (!heartBurst) return;
        for (let i = 0; i < count; i++) {
          const h = document.createElement("span");
          h.textContent = emoji;
          const dx = Math.round((Math.random() - 0.5) * 80);
          h.style.setProperty("--dx", dx + "px");
          h.style.animationDelay = (i * 0.08) + "s";
          heartBurst.appendChild(h);
          setTimeout(function () { h.remove(); }, 1600);
        }
      }

      function wigglePortrait() {
        if (!portrait) return;
        portrait.classList.remove("wiggle");
        void portrait.offsetWidth;
        portrait.classList.add("wiggle");
      }

      function updateMeters(level, xp, xpToNext) {
        const xpRow = document.querySelector(".meter-row");
        if (!xpRow) return;
        const fill = xpRow.querySelector(".fill");
        const val = xpRow.querySelector(".meter-val");
        if (fill) fill.style.width = Math.min(100, Math.round((xp / Math.max(1, xpToNext)) * 100)) + "%";
        if (val) val.textContent = xp + "/" + xpToNext;
        const brand = document.querySelector(".shell-brand");
        if (brand) brand.textContent = brand.textContent.replace(/[0-9]+$/, level);
      }

      function actionVisual(action) {
        if (action === "feed") spawnOverlayEmoji(FEED_EMOJI[species] || "🍪", 4);
        else if (action === "play") spawnOverlayEmoji(PLAY_EMOJI[species] || "🎲", 4);
        else if (action === "tease") spawnOverlayEmoji(TEASE_EMOJI, 3);
        wigglePortrait();
        // Swap the big ASCII face to its action variant, then restore.
        // The small mood emoji below is a secondary cue; the face is the
        // pet, so it has to actually react.
        const faces = ACTION_FACES[species];
        if (portrait && faces && faces[action]) {
          const prevFace = portrait.textContent;
          portrait.textContent = faces[action];
          setTimeout(function () { portrait.textContent = prevFace; }, 2000);
        }
        // Mood emoji secondary cue.
        const moodEl = document.querySelector(".pet-mood");
        if (moodEl) {
          const prev = moodEl.textContent;
          moodEl.textContent = MOOD_EMOJI[action] || prev;
          setTimeout(function () { moodEl.textContent = prev; }, 2000);
        }
      }

      async function doAction(action) {
        actionVisual(action);
        if (!serveMode) {
          showToast("offline preview — run \`bun run report --serve\` for real XP", "info");
          return;
        }
        try {
          const r = await fetch("/api/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: action }),
          });
          const data = await r.json();
          if (data.ok) {
            if (data.capped) {
              showToast("daily cap reached for " + action, "warn");
            } else if (data.awarded > 0) {
              const grumpyNote = data.grumpy ? " (grumpy — XP reduced)" : "";
              showToast("+" + data.awarded + " XP" + grumpyNote, "good");
            } else if (action === "tease") {
              const left = 3 - data.tease_count;
              if (data.grumpy) {
                showToast("pet is grumpy now — XP from next action will drop to 1", "warn");
              } else if (left > 0) {
                showToast("teased (" + left + " more before grumpy)", "info");
              }
            }
            if (typeof data.level === "number") updateMeters(data.level, data.xp, data.xp_to_next_level);
          } else if (data.error) {
            showToast(data.error, "warn");
          }
        } catch (err) {
          showToast("network error — server gone?", "warn");
        }
      }

      document.querySelectorAll(".btn[data-action]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const action = btn.getAttribute("data-action");
          if (action === "feed" || action === "play" || action === "tease") {
            doAction(action);
          }
        });
      });

      // ----- tabs -----
      const TAB_STORAGE_KEY = "siltpoke.report.tab";
      function activateTab(name) {
        document.querySelectorAll(".tab-btn").forEach(function (btn) {
          btn.setAttribute(
            "aria-selected",
            btn.getAttribute("data-tab") === name ? "true" : "false",
          );
        });
        document.querySelectorAll(".tab-content").forEach(function (el) {
          el.hidden = el.getAttribute("data-tab") !== name;
        });
        try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (e) {}
      }
      document.querySelectorAll(".tab-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const t = btn.getAttribute("data-tab");
          if (t) activateTab(t);
        });
      });
      try {
        const saved = localStorage.getItem(TAB_STORAGE_KEY);
        if (saved && document.querySelector('.tab-btn[data-tab="' + saved + '"]')) {
          activateTab(saved);
        }
      } catch (e) {}

      // ----- config panel -----
      const initialConfig = ${jsonForScript(rawCfg ?? {})};
      const cfgDiffEl = document.getElementById("cfg-diff");
      const cfgDiffLabel = document.getElementById("cfg-diff-label");
      const cfgToast = document.getElementById("cfg-toast");
      const cfgApplyBtn = document.getElementById("cfg-apply");
      const cfgResetBtn = document.getElementById("cfg-reset");

      const labels = {
        no_changes: ${jsonForScript(t.config_no_changes)},
        pending: ${jsonForScript(t.config_pending_changes)},
        copied: ${jsonForScript(t.config_copied)},
      };

      function readForm() {
        const out = {};
        document.querySelectorAll("[data-config-key]").forEach(function (el) {
          const key = el.getAttribute("data-config-key");
          const type = el.getAttribute("data-config-type");
          let v = el.value;
          if (type === "number") v = Number(v);
          out[key] = v;
        });
        return out;
      }

      function computeDiff() {
        const form = readForm();
        const diff = {};
        Object.keys(form).forEach(function (k) {
          if (form[k] !== initialConfig[k]) diff[k] = form[k];
        });
        return diff;
      }

      function refreshDiff() {
        const diff = computeDiff();
        const keys = Object.keys(diff);
        if (keys.length === 0) {
          cfgDiffEl.classList.remove("has-changes");
          cfgDiffLabel.textContent = labels.no_changes;
          if (cfgApplyBtn) cfgApplyBtn.disabled = true;
        } else {
          cfgDiffEl.classList.add("has-changes");
          cfgDiffLabel.textContent = labels.pending + " (" + keys.length + ")";
          if (cfgApplyBtn) cfgApplyBtn.disabled = false;
        }
      }

      document.querySelectorAll("[data-config-key]").forEach(function (el) {
        el.addEventListener("input", function () {
          const display = document.querySelector(
            "[data-config-display=\\"" + el.getAttribute("data-config-key") + "\\"]"
          );
          if (display) display.textContent = el.value;
          refreshDiff();
        });
      });

      if (cfgResetBtn) {
        cfgResetBtn.addEventListener("click", function () {
          document.querySelectorAll("[data-config-key]").forEach(function (el) {
            const key = el.getAttribute("data-config-key");
            const original = initialConfig[key];
            if (original === undefined || original === null) {
              el.value = el.tagName === "SELECT" ? el.options[0].value : "";
            } else {
              el.value = original;
            }
            const display = document.querySelector(
              "[data-config-display=\\"" + key + "\\"]"
            );
            if (display) display.textContent = el.value;
          });
          refreshDiff();
        });
      }

      if (cfgApplyBtn) {
        cfgApplyBtn.addEventListener("click", async function () {
          const diff = computeDiff();
          if (Object.keys(diff).length === 0) return;
          try {
            const r = await fetch("/api/config", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(diff),
            });
            const data = await r.json();
            if (data.ok && data.config) {
              Object.keys(data.config).forEach(function (k) {
                initialConfig[k] = data.config[k];
              });
              cfgToast.hidden = false;
              cfgToast.textContent = labels.copied;
              setTimeout(function () { cfgToast.hidden = true; }, 1800);
              showToast("config saved — restart Claude Code to apply", "good");
              refreshDiff();
            } else {
              showToast(data.error || "config save failed", "warn");
            }
          } catch (err) {
            showToast("network error — server gone?", "warn");
          }
        });
      }

      refreshDiff();
    })();
  </script>`;
}
