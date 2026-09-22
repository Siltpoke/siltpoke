#!/usr/bin/env bun
/**
 * Build the client island bundle.
 *
 * Main bundle: `src/web/client/index.ts` → `public/static/index.js`
 *   - code-split via Bun's `--splitting` flag
 *
 * Re-run on every UI change in dev; bundled at install time in production.
 */
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/**
 * Where the shipped bundle lives. `public/static/index.js` is TRACKED and is a
 * runtime asset the published package must carry, which is why `check:client`
 * blocks on `git diff --exit-code` over it.
 */
export const DEFAULT_OUTDIR = join(repoRoot, "public", "static");

// ─── Main bundle ──────────────────────────────────────────────────────────────

/**
 * `outdir` exists so a CALLER THAT IS NOT SHIPPING can build somewhere else.
 * Without it every caller wrote the tracked `public/static/index.js`, including
 * `tests/web/client/build.test.ts`, whose four unminified builds left the working
 * tree dirty after any `bun test` — measured 517,983 -> 896,916 bytes. `ci:local`
 * cannot catch that: its gate order runs `check:client` BEFORE `test`, so the
 * bundle is verified and then dirtied, and a later `git add -A` ships the
 * unminified copy (it has happened once). Default is unchanged, so the CLI and
 * `bun run build:client` behave exactly as before.
 */
export async function buildClient(
  opts: { minify?: boolean; outdir?: string } = {},
): Promise<{
  success: boolean;
  outputs: string[];
}> {
  const outdir = opts.outdir ?? DEFAULT_OUTDIR;
  await mkdir(outdir, { recursive: true });
  const entry = join(repoRoot, "src", "web", "client", "index.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    minify: opts.minify ?? false,
    splitting: true,
    naming: "[name].js",
  });
  return {
    success: result.success,
    outputs: result.outputs.map((o) => o.path),
  };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const minify = process.argv.includes("--minify");

  const mainResult = await buildClient({ minify });
  if (!mainResult.success) {
    process.stderr.write("[build-client] main bundle failed\n");
    process.exit(1);
  }
  for (const p of mainResult.outputs) {
    process.stdout.write(`[build-client] wrote ${p}\n`);
  }
}
