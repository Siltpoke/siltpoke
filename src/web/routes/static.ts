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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLE_TOUCH_ICON_HREF,
  FAVICON_DARK_HREF,
  FAVICON_LIGHT_HREF,
} from "../_shared/brand-icons";
import { buildTokensCss } from "../../../scripts/build-tokens";
import { buildClient } from "../../../scripts/build-client";

/**
 * Resolve the repo root by walking up from `here` until a `package.json` is
 * found. This survives BOTH layouts this module is loaded under:
 *   - source: here = <root>/src/web/routes → walks up 3 to <root>
 *   - bundled: the launchd daemon runs <root>/dist/siltpoke-daemon.js, so
 *     here = <root>/dist → walks up 1 to <root>
 * A fixed 3-up guess was correct only from source; from dist it overshot to
 * <root>/../.. and every /static/* 503'd (the daemon runs dist under launchd).
 * If no package.json is found before the filesystem root, fall back to the
 * historical 3-up guess so behavior degrades rather than throws.
 */
export function resolveRepoRoot(here: string): string {
  let dir = here;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return join(here, "..", "..", "..");
    dir = parent;
  }
  return dir;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot(here);

function tokensCssPath(): string {
  return join(repoRoot, "src", "web", "tokens", "tokens.css");
}

function clientBundlePath(): string {
  return join(repoRoot, "public", "static", "index.js");
}

function clientSrcDir(): string {
  return join(repoRoot, "src", "web", "client");
}

/** Newest file mtime (ms) anywhere under `dir`, recursively; 0 if empty. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

/**
 * A built bundle is STALE when any client island source file is newer than it —
 * an edited island would otherwise be served from a prior build (the daemon
 * serves the prebuilt `public/static/index.js`, it does not transpile on the
 * fly). A missing bundle counts as stale. When the client source tree is absent
 * (an installed package ships only the built bundle), the shipped bundle is
 * authoritative → never stale, so we never try (and fail) to rebuild it.
 */
export function bundleStale(bundlePath: string, srcDir: string = clientSrcDir()): boolean {
  if (!existsSync(bundlePath)) return true;
  if (!existsSync(srcDir)) return false;
  try {
    return newestMtimeMs(srcDir) > statSync(bundlePath).mtimeMs;
  } catch {
    // A transient fs error mid-walk — a dangling symlink, an atomic
    // write-then-rename race, an iCloud-evicted placeholder in this repo's
    // synced tree (see project CLAUDE.md), or a permission error — must NEVER
    // crash daemon startup (the enclosing ensureClientBundle is the fails-open
    // boundary, but the staleness check runs before its build try/catch). Fall
    // back to the existing bundle: the pre-staleness-check behavior, safe and
    // self-healing on the next clean boot.
    return false;
  }
}

/**
 * Ensure the client island bundle exists AND is up to date, rebuilding it when
 * it is missing or stale.
 *
 * `public/static/index.js` is a gitignored build artifact — a fresh clone or
 * marketplace install has no bundle until it's built, and without it every
 * Alpine/htmx island is dead (the page renders but nothing is clickable).
 * The daemon calls this at startup so `bun run report` works on first run.
 *
 * Staleness rebuild: the daemon serves the PREBUILT bundle (no on-the-fly
 * transpile), so editing an island source and restarting the daemon would
 * otherwise keep serving the old JS. Rebuilding when a client source file is
 * newer than the bundle closes that footgun for the plain `daemon start` dev
 * loop. (Interactive dev has `bun run dev-web`'s watcher; the e2e
 * `reuseExistingServer` path skips this entirely — kill the reused server after
 * an island edit, see playwright.config.ts.) On an unchanged boot the mtime
 * check is a cheap stat walk and no rebuild runs.
 *
 * Fails open: a build error is swallowed (the daemon must still start; the
 * `/static/index.js` route then serves its 503 hint). Injectable
 * `bundlePath`/`build`/`isStale` for tests.
 */
export async function ensureClientBundle(
  opts: {
    bundlePath?: string;
    build?: () => Promise<{ success: boolean }>;
    isStale?: () => boolean;
  } = {},
): Promise<{ built: boolean }> {
  const path = opts.bundlePath ?? clientBundlePath();
  const isStale = opts.isStale ?? (() => bundleStale(path));
  if (existsSync(path) && !isStale()) return { built: false };
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

/**
 * Brand icons live in `src/web/assets/` — a TRACKED directory, unlike
 * `public/static/` which is gitignored (it holds build artifacts only). That
 * matters for both distribution paths: `scripts/pack-dist.sh` builds the
 * tarball with `git archive`, which ships tracked files only, and the bundled
 * daemon runs from `<root>/dist/` where `resolveRepoRoot` still walks back to
 * `<root>` — so `<root>/src/web/assets/*` is present under both layouts.
 */
function assetPath(name: string): string {
  return join(repoRoot, "src", "web", "assets", name);
}

/**
 * `readFileSync` hands back a Node `Buffer`, which is a `Uint8Array` view over
 * a possibly-larger pooled ArrayBuffer — passing it straight to `c.body()` is
 * not type-compatible and slicing on the raw `.buffer` would leak neighbouring
 * pool bytes. Copy exactly this view's window.
 */
function readBinary(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Mount one icon at `route`, served from `src/web/assets/<file>`.
 *
 * Brand art changes at rebrand cadence, not per deploy, and the filenames
 * carry no content hash — an hour of caching keeps tab icons snappy without
 * stranding a new logo behind a stale cache for a whole day.
 */
function mountIcon(app: Hono, route: string, file: string, type: string): void {
  app.get(route, (c) => {
    const path = assetPath(file);
    if (!existsSync(path)) return c.notFound();
    return c.body(readBinary(path), 200, {
      "Content-Type": type,
      "Cache-Control": "public, max-age=3600",
    });
  });
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

  // Brand icons. The route paths come from brand-icons.tsx, the same module
  // the <head> links are rendered from, so a rename cannot desync the two
  // halves; that module also documents why there are three of them.
  mountIcon(app, FAVICON_LIGHT_HREF, "favicon-light.png", "image/png");
  mountIcon(app, FAVICON_DARK_HREF, "favicon-dark.png", "image/png");
  mountIcon(app, APPLE_TOUCH_ICON_HREF, "apple-touch-icon.png", "image/png");

  // Every page rendered by the daemon declares its icons in <head>, so this
  // route is only for the implicit request a browser makes when it has no
  // <link rel="icon"> to go on. Redirect rather than serve, so there is one
  // canonical URL per asset. PNG behind a `.ico` name is fine in every browser
  // that ships today.
  //
  // 302, deliberately NOT 301: browsers persist a permanent redirect across
  // restarts without revalidating, so a later rename (or serving a real .ico
  // here) would strand every visitor on the old target with no server-side way
  // to take it back. On a localhost daemon the extra round-trip costs nothing.
  // The light-mode variant: a client that fell back to /favicon.ico is by
  // definition one that took neither the <link> nor the script, so there is
  // nothing left to tell us which scheme it is in.
  app.get("/favicon.ico", (c) => c.redirect(FAVICON_LIGHT_HREF, 302));

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
