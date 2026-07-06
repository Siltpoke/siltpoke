// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Static asset routes — tokens.css + client bundle.
 *
 * tokens.css is regenerated lazily on the first request after a process
 * start if the on-disk file is stale relative to tokens.ts. The client
 * bundle lives at `public/static/index.js` after `bun build`. It is a
 * gitignored build artifact, so a fresh clone/install ships without it;
 * `ensureClientBundle()` (called at daemon start) builds it if missing so
 * the dashboard is interactive on first `bun run report`. The 503 branch in
 * the `/static/index.js` route is only a last-resort guard.
 */
import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTokensCss } from "../../../scripts/build-tokens";
import { buildClient } from "../../../scripts/build-client";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function tokensCssPath(): string {
  return join(repoRoot, "src", "web", "tokens", "tokens.css");
}

function clientBundlePath(): string {
  return join(repoRoot, "public", "static", "index.js");
}

/**
 * Ensure the client island bundle exists, building it once if missing.
 *
 * `public/static/index.js` is a gitignored build artifact — a fresh clone or
 * marketplace install has no bundle until it's built, and without it every
 * Alpine/htmx island is dead (the page renders but nothing is clickable).
 * The daemon calls this at startup so `bun run report` works on first run.
 *
 * Fails open: a build error is swallowed (the daemon must still start; the
 * `/static/index.js` route then serves its 503 hint). Injectable
 * `bundlePath`/`build` for tests.
 */
export async function ensureClientBundle(
  opts: {
    bundlePath?: string;
    build?: () => Promise<{ success: boolean }>;
  } = {},
): Promise<{ built: boolean }> {
  const path = opts.bundlePath ?? clientBundlePath();
  if (existsSync(path)) return { built: false };
  const build = opts.build ?? (() => buildClient({ minify: true }));
  try {
    const result = await build();
    return { built: result.success };
  } catch {
    return { built: false };
  }
}

function tailwindCssPath(): string {
  return join(repoRoot, "public", "static", "tailwind.css");
}

export function mountStaticRoutes(app: Hono): void {
  app.get("/static/tokens.css", (c) => {
    buildTokensCss(); // idempotent — re-emits only on content change
    const path = tokensCssPath();
    if (!existsSync(path)) {
      return c.text("/* tokens.css missing — run bun scripts/build-tokens.ts */", 503, {
        "Content-Type": "text/css",
      });
    }
    return c.body(readFileSync(path, "utf8"), 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
  });

  // Tailwind v4 utilities (incremental adoption). Built by
  // `bun run build:tailwind` → public/static/tailwind.css (NOT lazily rebuilt
  // on request — the CLI is slower than tokens; rebuild explicitly after class
  // changes). no-store so a rebuild is picked up without a hard refresh.
  app.get("/static/tailwind.css", (c) => {
    const path = tailwindCssPath();
    if (!existsSync(path)) {
      return c.text(
        "/* tailwind.css missing — run `bun run build:tailwind` */",
        503,
        { "Content-Type": "text/css" },
      );
    }
    return c.body(readFileSync(path, "utf8"), 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    });
  });

  app.get("/static/index.js", (c) => {
    const path = clientBundlePath();
    if (!existsSync(path)) {
      return c.text(
        "// client bundle missing — run `bun scripts/build-client.ts`",
        503,
        { "Content-Type": "application/javascript" },
      );
    }
    // No-store on the bare index.js so the browser always picks up the
    // latest bundle after a rebuild. Hashed island chunks (<name>-<hash>.js)
    // still cache aggressively below.
    return c.body(readFileSync(path, "utf8"), 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    });
  });

  // Serve content-hashed island chunks.
  // A route-only island ships as a separate chunk (loaded ahead of index.js
  // via Layout.preloadIslands so it registers with globalThis.Alpine before
  // Alpine.start()). Restricted to a /static/<name>-<hash>.js pattern with
  // a strict regex so the route can't be coerced into reading arbitrary
  // paths off disk (chunk names → only hexish chars + dash, no slashes / dots).
  app.get("/static/:filename{[a-z0-9-]+\\.js}", (c) => {
    const filename = c.req.param("filename");
    // Reject anything that doesn't look like a hashed-chunk emission.
    if (!/^[a-z0-9]+-[a-f0-9]{6,16}\.js$/.test(filename)) {
      return c.notFound();
    }
    const path = join(repoRoot, "public", "static", filename);
    if (!existsSync(path)) return c.notFound();
    return c.body(readFileSync(path, "utf8"), 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      // Content-hashed → safe to cache aggressively
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });
}
