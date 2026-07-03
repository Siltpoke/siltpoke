#!/usr/bin/env bun
/**
 * Reads `src/web/tokens/tokens.ts` and writes `src/web/tokens/tokens.css`
 * with the canonical CSS custom-property block on `:root`.
 *
 * Runs:
 *   - on daemon start (idempotent; only writes if changed)
 *   - manually via `bun scripts/build-tokens.ts`
 *   - in CI to assert the CSS file matches the TS source
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensToCss } from "../src/web/tokens/tokens";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCssPath = join(here, "..", "src", "web", "tokens", "tokens.css");

export function buildTokensCss(targetPath: string = tokensCssPath): {
  wrote: boolean;
  path: string;
} {
  const desired = tokensToCss();
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath, "utf8");
    if (current === desired) return { wrote: false, path: targetPath };
  }
  writeFileSync(targetPath, desired, "utf8");
  return { wrote: true, path: targetPath };
}

if (import.meta.main) {
  const result = buildTokensCss();
  if (result.wrote) {
    process.stdout.write(`[build-tokens] wrote ${result.path}\n`);
  } else {
    process.stdout.write(`[build-tokens] unchanged ${result.path}\n`);
  }
}
