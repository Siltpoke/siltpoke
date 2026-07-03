// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * `GET /api/fs/list`: the secret-gated, allow-root-sandboxed
 * directory browser behind the in-dashboard folder picker. Reuses the shared
 * path guard (`validateListDir` + `isContainedInAllowRoots`) — no second path
 * validation — and the `fs-browse` primitives. Reads the user's FS structure
 * on request, so it requires the daemon secret (unlike the read-only
 * repo-graph GETs).
 */
import { dirname } from "node:path";
import type { Hono } from "hono";
import { loadIndexConfig, resolveAllowRoots } from "../../config/index-config";
import { detectCodebase, listSubdirs } from "../../repo-graph/fs-browse";
import { isContainedInAllowRoots, validateListDir } from "../../repo-graph/index-guard";
import { siltpokeRoot } from "../../installer/paths";
import { isAuthorized } from "../auth";

export interface FsRouteDeps {
  /** Override siltpoke home dir (tests). */
  home?: string;
  /** Daemon secret (required — this reads the user's filesystem). */
  secret?: string;
}

export function mountFsRoutes(app: Hono, deps: FsRouteDeps): void {
  app.get("/api/fs/list", async (c) => {
    // Fail CLOSED (same as the index endpoint): no secret ⇒ reject.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    const home = deps.home ?? siltpokeRoot();
    const allowRoots = resolveAllowRoots(await loadIndexConfig(home));

    // Omitted dir → default to the first allow-root ($HOME) — the browser's start.
    const dirParam = c.req.query("dir")?.trim();
    const target = dirParam && dirParam.length > 0 ? dirParam : (allowRoots[0] ?? "");

    // Reuse the shared guard (canonicalize + containment, allow-root-itself listable).
    const v = validateListDir(target, { allowRoots });
    if (!v.ok) return c.json({ success: false, data: null, error: v.reason }, 400);

    // `parent` = the dir to navigate "up" to — but only when it's still within an
    // allow-root. At an allow-root, dirname() is ABOVE it → not contained → null,
    // so the FE has no "up" and the user can't escape above $HOME.
    const parentCandidate = dirname(v.realPath);
    const parent =
      parentCandidate !== v.realPath &&
      isContainedInAllowRoots(parentCandidate, allowRoots, { allowRootItself: true })
        ? parentCandidate
        : null;

    const listing = listSubdirs(v.realPath);
    return c.json({
      success: true,
      data: {
        dir: v.realPath,
        // The Index enable-gate is MARKERS-ONLY (a stray source file doesn't make
        // a dir an index-worthy project root). Per-entry browse badges keep the
        // broader signal — see listSubdirs.
        isCodebase: detectCodebase(v.realPath, { markersOnly: true }),
        parent,
        entries: listing.entries,
        truncated: listing.truncated ?? 0,
      },
      error: null,
    });
  });
}
