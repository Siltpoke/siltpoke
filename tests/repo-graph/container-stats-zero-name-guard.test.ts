/**
 * Zero framework/semantic words in the count logic + label/render code.
 *
 * The structural counting tool must REPORT literal patterns, never INTERPRET them.
 * A semantic word as a string literal = interpretation = a break. Basenames reach
 * the UI only as runtime values from `node.name`, never written in code.
 *
 * The ONLY file permitted to contain these words is `honest-notes.ts` — and only
 * inside sentences that DENY the tool can produce them. It is EXCLUDED here, by
 * exact path; an assertion below keeps it permanently excluded so a later edit
 * can't quietly add it and kill its own disclaimer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "page", "pages", "component", "components", "view", "views",
  "endpoint", "endpoints", "api", "route", "routes", "controller",
  "service", "model", "models", "serializer", "django", "flask",
  "next", "nextjs", "react", "vue", "siltpoke",
  // dir→layer taxonomy LABEL words — the residue `layerNameFor` could emit. The
  // degraded band grouping must read the first path segment as DATA and label it
  // verbatim, never write one of these as a layer-name literal.
  "services", "data", "ui", "middleware", "utility", "utils",
  "state", "types", "hooks", "assets", "entry", "infrastructure",
  "layer", "layers", "handler", "handlers",
];

// The count logic + label formatters + the C4 derive passthrough. Anywhere a
// semantic word would mean the tool is interpreting. NOT honest-notes.ts.
const GUARDED = [
  "src/repo-graph/container-stats.ts",
  "src/repo-graph/container-stats-labels.ts", // guarded from the start
  "src/web/client/islands/repo-graph-c4-derive.ts",
];

const EXCLUDED = "src/repo-graph/honest-notes.ts";

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
}

/**
 * Blank the quoted module path in `from "…"` / `import "…"` statements. An
 * import specifier is a FILENAME (structure/data) — e.g. `./repo-graph-c4-model`
 * — never an interpretive label, so a forbidden word inside a path is not a
 * break. Stripped before grepping so the embedded-word regex stays focused
 * on label vocabulary, not the import graph.
 */
function stripModuleSpecifiers(src: string): string {
  return src
    .replace(/\bfrom\s+["'`][^"'`]*["'`]/g, "from <path>")
    .replace(/\bimport\s+["'`][^"'`]*["'`]/g, "import <path>");
}

function existsRel(rel: string): boolean {
  try {
    readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("container counts — zero framework/semantic words", () => {
  for (const rel of GUARDED) {
    test(`${rel} has no forbidden semantic literal`, () => {
      if (!existsRel(rel)) return; // skip files that don't exist yet
      const code = stripModuleSpecifiers(
        stripComments(
          readFileSync(join(import.meta.dir, "..", "..", rel), "utf8"),
        ),
      );
      // Catch a forbidden word ANYWHERE inside a string literal (word-boundary),
      // not just a fully quote-wrapped token. The old `['"`]${w}['"`]` missed
      // embedded leaks like `${count} pages` or "no recurring page pattern" —
      // exactly the strings a label formatter writes. This matches the word
      // when flanked by non-quote chars within one literal; a bare identifier
      // (e.g. a `next` pointer) is not in a string, so it stays clean.
      const hits = FORBIDDEN.filter((w) =>
        new RegExp(`["'\`][^"'\`]*\\b${w}\\b[^"'\`]*["'\`]`, "i").test(code),
      );
      expect(hits).toEqual([]);
    });
  }

  test("honest-notes.ts is EXCLUDED — the one place denial sentences may use these words", () => {
    expect(GUARDED).not.toContain(EXCLUDED);
  });
});
