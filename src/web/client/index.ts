// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Client island bundle entry.
 *
 * Imports Alpine + the @nanostores/alpine plugin. The plugin contributes
 * three directives/magics: `x-nano` (read a store into component scope),
 * `x-nano-model` (two-way binding), and `$nano()` (magic helper).
 *
 * Each island in `islands/` registers itself via
 * `document.addEventListener("alpine:init", ...)` at import time;
 * Alpine.start() walks the DOM for `x-data` attributes after all islands
 * are registered.
 *
 * Build: `bun scripts/build-client.ts [--minify]`
 * Served: GET /static/index.js
 */

import { NanoStores } from "@nanostores/alpine";
import Alpine from "alpinejs";

// Register the nanostores plugin BEFORE Alpine.start() so the
// x-nano / x-nano-model / $nano directives are available to all islands.
Alpine.plugin(NanoStores);

// Not an Alpine island — a single global listener that re-implements the
// browser's own `#fragment` scroll after an hx-boost swap, which suppresses it.
// Imported here because it must be live on every dashboard surface, not just
// the one that noticed it was missing.
import "./islands/hash-anchor";
// Island registrations (each side-effect import registers on alpine:init).
import "./islands/sidebar";
// Three-state theme toggle in the sidebar footer (system -> light -> dark).
import "./islands/theme-toggle";
import "./islands/build-stamp";
import "./islands/modal";
import "./islands/chat-stream";
import "./islands/action-result";
// repoGraph is a small vanilla DOM+SVG renderer (cytoscape
// dropped), so it ships in the main bundle like every other island — no lazy
// chunk, no preload, registers + re-inits on hx-boost via the standard path.
import "./islands/repo-graph";
// Floating chat, present on every dashboard surface (mounted by the
// global Layout, persisted across hx-boost via hx-preserve).
import "./islands/floating-chat";
// Memory Book timeline island (global bundle, no route-manifest plumbing).
import "./islands/memory-book";
// Active-repos card — per-row expand + on-demand summary generation.
import "./islands/active-repos";
import "./islands/staleness-badge";
// "Since you last looked" discovery panel (slice ③) — lazy GET + gesture-
// bound advance/mark-all.
import "./islands/since-you-looked";
// Progress a retired map — which a retired surface the detail rail shows (pure x-show).
// Settings — review-brain selector (family/model -> POST /api/brain/roles/review).
import "./islands/brain-settings";
// Settings — directly-selectable per-role rows (review/extract → POST /api/brain/roles/:role).
import "./islands/role-row";
// Timeline (/timeline) — ⏱ which unit of work closes before a review fires (→ POST /api/config).
import "./islands/review-unit";
// Knowledge screen — ⌘K / Ctrl-K command-palette search overlay (Task 13).

// Expose Alpine on window — the documented seam for the @nanostores/alpine
// plugin AND for browser-console debugging.
//
// INVARIANT: this assignment must stay synchronous and immediately before
// `Alpine.start()`, with no `await` between them. `tests/e2e/knowledge-drawer
// .spec.ts`'s "F opens the drawer and Escape closes it" test reads readiness
// off `window.Alpine !== undefined` -- that wait is a real signal only
// because of this ordering; inserting an `await` here would silently degrade
// it back into the race it was written to fix, with nothing to catch it.
(globalThis as unknown as { Alpine: typeof Alpine }).Alpine = Alpine;

Alpine.start();
