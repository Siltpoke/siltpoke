// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * `/api/repo-graph/seen*` daemon routes (slice ③, spec R5/R6/R7/R13/R15).
 *
 *   GET  /api/repo-graph/seen?repo=<projHash>          delta + composed staleness
 *   POST /api/repo-graph/seen/advance   { repo, path }  secret-gated
 *   POST /api/repo-graph/seen/mark-all  { repo }        secret-gated
 *
 * Extracted out of `repo-graph.tsx` (fast-follow after slice ③ landed —
 * repo-graph.tsx was 2x the 800-LOC hard cap). These 3 handlers share ZERO
 * closure state with the rest of that file (no `activeIndexHash`/
 * `activeAbort`/`taskRegistry` lock), so the move is a pure verbatim
 * relocation — behavior unchanged.
 *
 * This module (together with `/seen/mark-all`) is the SOLE caller of
 * `withHumanOrigin` in the codebase — enforced by a dependency-cruiser rule
 * (`.dependency-cruiser.cjs`, `seen-advance-human-origin-only-daemon-route`)
 * so no producer module (indexer, review runner, …) can mint its own
 * human-origin token by importing `seen-advance.ts` directly.
 */
import type { Hono } from "hono";
import { loadRepoGraphConfig } from "../../config/repo-graph-config";
import { siltpokeRoot } from "../../installer/paths";
import { readIndexStaleness } from "../../repo-graph/index-health";
import { isValidProjHash, resolveRepoByHash } from "../../repo-graph/repo-registry";
import { advanceSeenFile, markAllSeen, withHumanOrigin } from "../../repo-graph/seen-advance";
import { classifyAll } from "../../repo-graph/seen-delta";
import { stalenessVerdict } from "../../repo-graph/staleness-verdict";
import { readFingerprints, readSeen } from "../../repo-graph/store";
import { isAuthorized } from "../auth";
import { attachWhy } from "./seen-why";

export interface SeenRouteDeps {
  /** Override siltpoke home dir (tests). */
  home?: string;
  /** Daemon shared secret — required to authorize the mutating POSTs. */
  secret?: string;
}

export function mountSeenRoutes(app: Hono, deps: SeenRouteDeps): void {
  const { home } = deps;

  // ── GET /api/repo-graph/seen ─────────────────────────────────────────────
  // Slice ③ (R5/R6/R15): user-seen watermark delta + composed index-staleness
  // verdict. Read-only (classifyAll + a fresh fingerprint re-hash for the
  // staleness side, no mutation) → no secret gate, matching the other read
  // GETs (/staleness, /repos, /arch). `repo` is required, same posture as
  // /staleness.
  //
  // R15 composition: `staleness` is the SAME slice-② verdict `/staleness`
  // returns — the surface never gets to say "0 changes" while the persisted
  // index itself has drifted from disk; the client renders both signals
  // side by side.
  //
  // `unknown_baseline` suppression: when the on-disk `seen.json` was
  // present-but-corrupt (readSeen's own broken-shape guard sets
  // `unknown_baseline:true`), `deltas` is returned EMPTY rather than running
  // `classifyAll` — the client shows a "we don't know what you've seen"
  // banner instead of a false wall of "every file is new_to_you".
  //
  // Slice ④ (task 6): each surviving delta gets a `why: WhyAnchor` attached
  // via `attachWhy` (rung "U"/1/2/3 — see `../../repo-graph/why-lookup`), an
  // honest ANCHOR ("you asked: …" / "changed in session …") not a causal
  // claim. Skipped entirely when `deltas` is already `[]` (unknown baseline
  // OR nothing changed) — nothing to attach WHY to.
  app.get("/api/repo-graph/seen", async (c) => {
    const repo = c.req.query("repo");
    if (!repo || !isValidProjHash(repo)) {
      return c.json({ success: false, data: null, error: "bad_repo" }, 400);
    }
    const resolved = await resolveRepoByHash(repo, { home: home ?? siltpokeRoot() });
    if (!resolved || resolved.project_root === null) {
      return c.json({ success: false, data: null, error: "unknown_repo" }, 400);
    }
    const seen = await readSeen(resolved.storage_dir);
    // C7: an unindexed repo's `readFingerprints` returns the empty shape
    // (never throws) — `classifyAll` itself abstains (returns `[]`) on an
    // empty `current`, so this composes safely with no special-casing here.
    const current = await readFingerprints(resolved.storage_dir);
    const cfg = await loadRepoGraphConfig(home ?? siltpokeRoot());
    const staleness = stalenessVerdict(
      await readIndexStaleness({ cwd: resolved.project_root, home: home ?? siltpokeRoot() }),
      cfg.staleness_warn_pct,
    );
    const deltas = seen.unknown_baseline ? [] : classifyAll(seen, current);
    // Empty deltas (unknown baseline OR nothing changed) short-circuits —
    // no lookups to run, keeps the "known-nothing-changed" path as cheap as
    // it was before this task.
    const deltasWithWhy = deltas.length === 0
      ? deltas
      : await attachWhy(deltas, { cwd: resolved.project_root, baselineSha: seen.baseline_sha ?? undefined });
    return c.json({
      success: true,
      data: { unknown_baseline: seen.unknown_baseline, staleness, deltas: deltasWithWhy },
      error: null,
    });
  });

  // ── POST /api/repo-graph/seen/advance ────────────────────────────────────
  // Advance ONE file's watermark entry to its current fingerprint. Secret-
  // gated (mutating, browser-reachable) — mirrors `POST /index`. This route
  // (together with `/seen/mark-all` below) is the SOLE caller of
  // `withHumanOrigin` in the codebase — enforced by a dependency-cruiser rule
  // (`.dependency-cruiser.cjs`) so no producer module (indexer, review
  // runner, …) can mint its own human-origin token.
  app.post("/api/repo-graph/seen/advance", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    let body: { repo?: unknown; path?: unknown };
    try {
      body = (await c.req.json()) as { repo?: unknown; path?: unknown };
    } catch {
      return c.json({ success: false, data: null, error: "invalid_json" }, 400);
    }
    const repo = typeof body.repo === "string" ? body.repo : "";
    if (!repo || !isValidProjHash(repo)) {
      return c.json({ success: false, data: null, error: "bad_repo" }, 400);
    }
    const path = typeof body.path === "string" ? body.path : "";
    if (!path) {
      return c.json({ success: false, data: null, error: "bad_path" }, 400);
    }
    const resolved = await resolveRepoByHash(repo, { home: home ?? siltpokeRoot() });
    if (!resolved || resolved.project_root === null) {
      return c.json({ success: false, data: null, error: "unknown_repo" }, 400);
    }
    // C7: an unindexed repo's `current` is empty — `advanceSeenFile` itself
    // abstains (no-op, no crash) on an empty `current`; nothing special
    // needed here.
    const current = await readFingerprints(resolved.storage_dir);
    await withHumanOrigin((origin) => advanceSeenFile(resolved.storage_dir, path, current, origin));
    return c.json({ success: true, data: { advanced: true }, error: null });
  });

  // ── POST /api/repo-graph/seen/mark-all ───────────────────────────────────
  // Advance EVERY file's watermark entry at once ("mark all as seen").
  // Secret-gated; the other `withHumanOrigin` call site.
  app.post("/api/repo-graph/seen/mark-all", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    let body: { repo?: unknown };
    try {
      body = (await c.req.json()) as { repo?: unknown };
    } catch {
      return c.json({ success: false, data: null, error: "invalid_json" }, 400);
    }
    const repo = typeof body.repo === "string" ? body.repo : "";
    if (!repo || !isValidProjHash(repo)) {
      return c.json({ success: false, data: null, error: "bad_repo" }, 400);
    }
    const resolved = await resolveRepoByHash(repo, { home: home ?? siltpokeRoot() });
    if (!resolved || resolved.project_root === null) {
      return c.json({ success: false, data: null, error: "unknown_repo" }, 400);
    }
    // C7: `markAllSeen` itself abstains (no-op, no crash) on an empty
    // `current` -- an unindexed repo's mark-all silently does nothing rather
    // than writing a self-defeating empty `seen.json`.
    const current = await readFingerprints(resolved.storage_dir);
    // A local const (not a property access) so TS narrows it inside the
    // closure below -- `resolved.project_root` itself doesn't narrow across
    // a closure boundary even after the null-guard above.
    const projectRoot = resolved.project_root;
    await withHumanOrigin((origin) => markAllSeen(resolved.storage_dir, projectRoot, current, origin));
    return c.json({ success: true, data: { marked: true }, error: null });
  });
}
