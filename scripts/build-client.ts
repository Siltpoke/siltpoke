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
const outdir = join(repoRoot, "public", "static");

// ─── Main bundle ──────────────────────────────────────────────────────────────

export async function buildClient(opts: { minify?: boolean } = {}): Promise<{
  success: boolean;
  outputs: string[];
}> {
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
