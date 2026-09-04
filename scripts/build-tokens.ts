#!/usr/bin/env bun
/**
 * Reads `src/web/tokens/tokens.ts` and writes `src/web/tokens/tokens.css`
 * with the canonical CSS custom-property block on `:root`.
 *
 * Runs:
 *   - on daemon start (idempotent; only writes if changed)
 *   - manually via `bun scripts/build-tokens.ts`
 *   - in CI (`bun run build:web`, before `e2e` — see .github/workflows/test.yml)
 *     to regenerate the CSS file from the TS source. `tokens.css` and
 *     `public/static/` are gitignored, so there is no committed copy to
 *     drift against — CI regenerates rather than asserting.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensToCss, tokensToTailwindTheme } from "../src/web/tokens/tokens";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCssPath = join(here, "..", "src", "web", "tokens", "tokens.css");
const tailwindCssPath = join(here, "..", "src", "web", "tokens", "tailwind.css");

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

const START = "  /* build-tokens:start */";
const END = "  /* build-tokens:end */";

/**
 * Rewrite the body of the `@theme { … }` block in `tailwind.css`, between the
 * `build-tokens:start`/`build-tokens:end` sentinel comments.
 *
 * Throws if the sentinels are missing — a missing sentinel is a hard error,
 * not a silent skip. A silent skip is how a generator stops generating
 * without anyone noticing.
 */
export function buildTailwindTheme(targetPath: string = tailwindCssPath): {
  wrote: boolean;
  path: string;
} {
  const current = readFileSync(targetPath, "utf8");
  const s = current.indexOf(START);
  const e = current.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `build-tokens: sentinels not found in ${targetPath}. ` +
        "The @theme block must contain the build-tokens:start/end comments.",
    );
  }
  const desired =
    current.slice(0, s + START.length) + "\n" + tokensToTailwindTheme() + "\n" + current.slice(e);
  if (desired === current) return { wrote: false, path: targetPath };
  writeFileSync(targetPath, desired, "utf8");
  return { wrote: true, path: targetPath };
}

if (import.meta.main) {
  const cssResult = buildTokensCss();
  if (cssResult.wrote) {
    process.stdout.write(`[build-tokens] wrote ${cssResult.path}\n`);
  } else {
    process.stdout.write(`[build-tokens] unchanged ${cssResult.path}\n`);
  }

  const themeResult = buildTailwindTheme();
  if (themeResult.wrote) {
    process.stdout.write(`[build-tokens] wrote ${themeResult.path}\n`);
  } else {
    process.stdout.write(`[build-tokens] unchanged ${themeResult.path}\n`);
  }
}
