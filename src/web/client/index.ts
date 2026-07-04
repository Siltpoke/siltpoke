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
import Alpine from "alpinejs";
import { NanoStores } from "@nanostores/alpine";

// Register the nanostores plugin BEFORE Alpine.start() so the
// x-nano / x-nano-model / $nano directives are available to all islands.
Alpine.plugin(NanoStores);

// Island registrations (each side-effect import registers on alpine:init).
import "./islands/sidebar";
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

// Expose Alpine on window — the documented seam for the @nanostores/alpine
// plugin AND for browser-console debugging.
(globalThis as unknown as { Alpine: typeof Alpine }).Alpine = Alpine;

Alpine.start();
