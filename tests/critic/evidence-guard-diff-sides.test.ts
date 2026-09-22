import { expect, test } from "bun:test";
import { guardCritique } from "../../src/critic/evidence-guard";
import { SNIPPET_CAP, type BrainOutput } from "../../src/brain/schema";

/**
 * A citation of real code must not be refused because of how the DIFF spells
 * it, or because siltpoke itself shortened it.
 *
 * Measured 2026-09-10 by re-running this guard over every recorded review with
 * a verdict, counting only reviews whose recorded drop count it reproduces
 * (an internal design note): 98 refused
 * citations, 18 of them real multi-line code. A unified diff prefixes every
 * line with `+`, `-` or a space; a reviewer quotes the code as the FILE reads,
 * so no multi-line quote can ever be a verbatim substring of the diff. Three of
 * the 18 were also cut to 240 chars by the schema layer, which appends `…` — a
 * character the corpus never contains.
 *
 * The rule these tests pin: a multi-line snippet may match ONE side of ONE
 * hunk with the prefixes removed — the new file's text (context + added) or
 * the old file's (context + removed). Never both sides at once, never across
 * hunks: either would accept a block of text that exists in no version of the
 * file.
 */

const base: BrainOutput = {
  mood: "watching",
  pose: "peek",
  bubble_short: "x",
  bubble_long: "",
  critique_for_claude: "x",
  severity: "medium",
  confidence: "medium",
  xp_earned_events: [],
  findings: [],
  evidence: [],
};

// The exact hunk critique c-f7c0 (2026-09-05) cited — taken from the recorded
// git-diff tool output of trace bb55fef6, not written by hand.
const CRITIQUE_TS_DIFF = [
  "diff --git a/src/state/critique.ts b/src/state/critique.ts",
  "index 1111111..2222222 100644",
  "--- a/src/state/critique.ts",
  "+++ b/src/state/critique.ts",
  "@@ -62,6 +62,17 @@ function escapeForFence(text: string): string {",
  '  * reviewer cited nothing" instead of "nobody checked" — left the whole suite',
  "  * green. One source, one thing to pin.",
  "  */",
  "+/**",
  '+ * The labels that mean "nothing was examined" — as a predicate, because there',
  "+ * are now two and every consumer that hard-coded the first one would silently",
  "+ * treat the second as a checked review. TypeScript cannot catch that: both are",
  '+ * members of the same union, so `=== "not_checked"` stays valid and just stops',
  "+ * being true.",
  "+ */",
  "+export function isUnchecked(label: EvidenceLabel | null): boolean {",
  '+  return label === "not_checked" || label === "not_checked_budget";',
  "+}",
  "+",
  " function labelOf(input: CritiqueInput): EvidenceLabel {",
  '   return input.evidence_verdict?.label ?? "not_checked";',
  " }",
  "@@ -135,5 +146,5 @@ function buildEvidenceSection(input: CritiqueInput): string[] {",
  "   // unexamined citations would start lying.",
  '-  const heading = verdict.label === "not_checked" ? "Unchecked" : "Confirmed";',
  '+  const heading = isUnchecked(verdict.label) ? "Unchecked" : "Confirmed";',
  "   lines.push(...renderCitedItems(verdict));",
  "   return lines;",
  " }",
  "",
].join("\n");

const FILE = "src/state/critique.ts";
const changed = new Set([FILE]);

function check(snippet: string, corpus = CRITIQUE_TS_DIFF) {
  return guardCritique(
    { ...base, evidence: [{ tool: "git-diff", file: FILE, line: 65, snippet }] },
    "NORMAL",
    corpus,
    changed,
  );
}

test("c-f7c0: a multi-line quote of added code, as the file reads, is verified", () => {
  // The citation the guard refused on 2026-09-05. Every character is real code
  // the reviewer was shown; only the `+` column is missing.
  const v = check(
    'export function isUnchecked(label: EvidenceLabel | null): boolean {\n  return label === "not_checked" || label === "not_checked_budget";\n}',
  );
  expect(v.label).toBe("verified");
  expect(v.unverified).toEqual([]);
});

test("a quote spanning added lines and unchanged context is verified", () => {
  const v = check("}\n\nfunction labelOf(input: CritiqueInput): EvidenceLabel {");
  expect(v.label).toBe("verified");
});

test("a multi-line quote of the OLD side (context + removed) is verified", () => {
  // Quoting what a change deleted is legitimate — a single removed line already
  // passes as a substring of its `-` line, so refusing its multi-line form would
  // be the same inconsistency this file exists to remove.
  const v = check(
    '  // unexamined citations would start lying.\n  const heading = verdict.label === "not_checked" ? "Unchecked" : "Confirmed";\n  lines.push(...renderCitedItems(verdict));',
  );
  expect(v.label).toBe("verified");
});

test("a quote stitching a REMOVED line to an ADDED line is refused", () => {
  // Both lines are real, but this block exists in neither version of the file.
  const v = check(
    '  const heading = verdict.label === "not_checked" ? "Unchecked" : "Confirmed";\n  const heading = isUnchecked(verdict.label) ? "Unchecked" : "Confirmed";',
  );
  expect(v.label).toBe("none_verified");
});

test("a quote bridging two hunks is refused", () => {
  // The last line of hunk 1 and the first of hunk 2 are 80 lines apart in the
  // file; adjacent in the diff text is not adjacent in the code.
  const v = check("}\n  // unexamined citations would start lying.");
  expect(v.label).toBe("none_verified");
});

test("real lines quoted in the wrong order — c-f7c0's second citation — stay refused", () => {
  // The closing brace sits AFTER the signature in the file, never before it.
  const v = check("}\nexport function isUnchecked(label: EvidenceLabel | null): boolean {");
  expect(v.label).toBe("none_verified");
});

test("a fabricated multi-line quote stays refused", () => {
  const v = check("export function isUnchecked(label: string): boolean {\n  return true;\n}");
  expect(v.label).toBe("none_verified");
});

test("the hunk ends where its header's line counts say, not at the next prefix-shaped line", () => {
  // Text that follows a hunk in the corpus (another tool's output, the corpus
  // separator) can begin with a space or a dash. Absorbing it would let a quote
  // run from the code into text that is not code.
  const corpus = [
    "diff --git a/src/state/critique.ts b/src/state/critique.ts",
    "--- a/src/state/critique.ts",
    "+++ b/src/state/critique.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;",
    " trailing text from another tool that starts with a space",
  ].join("\n");
  expect(check("const a = 2;\ntrailing text from another tool that starts with a space", corpus).label).toBe(
    "none_verified",
  );
  // Anti-vacuous: the hunk itself is still readable.
  expect(check("const a = 2;", corpus).label).toBe("verified");
});

// The formatted section's copy of a hunk, shaped like `formatGitDiffBlock`'s
// output with the file heading included — a corpus that never names the cited
// file is the #726 "nothing to check against" case and would read not_checked,
// which is not what these tests are about.
const formatted = (...body: string[]) => [`#### ${FILE}`, "```diff", "@@ -1,250 +1,250 @@", ...body, "```"].join("\n");

test("the formatted section's copy of a hunk is not parsed; the raw diff is", () => {
  // In production the raw diff always carries the same lines, so this costs no
  // real quote — the positive half is the c-f7c0 test above, which is raw.
  expect(check("keep this line\nadded line here", formatted(" keep this line", "+added line here")).label).toBe(
    "none_verified",
  );
});

test("a summary written into a long formatted hunk is never read as code", () => {
  // Cross-family review (agy, 2026-09-10). The header still promises 250 lines,
  // so a summary that starts with `- ` would be taken as removed code. Today's
  // summary starts with `[`, which is why this has to be pinned structurally
  // rather than left to whatever a future summarizer happens to write.
  const corpus = formatted("- Refactored auth logic to support OAuth2 tokens", "- More details here");
  expect(check(" Refactored auth logic to support OAuth2 tokens\n More details here", corpus).label).toBe(
    "none_verified",
  );
});

const rawHead = [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`];

test("a raw diff cut short mid-hunk stops at what siltpoke appends after it", () => {
  // Cross-family review (agy, 2026-09-10). A timed-out diff keeps partial
  // stdout, so the header still owes lines when the corpus separator — which
  // starts with `-` — arrives.
  for (const sentinel of ["--- corpus separator ---", "--- stderr ---"]) {
    const corpus = [...rawHead, "@@ -1,5 +1,5 @@", "-const kept = 1;", "-const alsoKept = 2;", sentinel, "-next"].join("\n");
    expect(check("const kept = 1;\nconst alsoKept = 2;", corpus).label).toBe("verified");
    expect(check(`const alsoKept = 2;\n${sentinel.slice(1)}`, corpus).label).toBe("none_verified");
  }
});

test("a removed line that happens to read `-- ` is still code", () => {
  // The sentinels are matched exactly, not by their `---` prefix: a removed SQL
  // comment prints as `--- ...` and has to stay quotable.
  const corpus = [...rawHead, "@@ -1,2 +1,0 @@", "--- drop the index first", "-DROP INDEX idx_users;"].join("\n");
  expect(check("-- drop the index first\nDROP INDEX idx_users;", corpus).label).toBe("verified");
});

test("a multi-line quote of a CRLF file is verified", () => {
  const corpus = [...rawHead, "@@ -1,1 +1,2 @@", "-oldCode();", "+newCodeA();", "+newCodeB();", ""].join("\r\n");
  expect(check("newCodeA();\nnewCodeB();", corpus).label).toBe("verified");
});

test("a blank context line printed with no leading space does not end the hunk", () => {
  // `diff.suppressBlankEmpty` prints blank context as an empty line.
  const corpus = [...rawHead, "@@ -1,3 +1,5 @@", " function test() {", "", "+  const a = 1;", "+  const b = 2;", " }"].join(
    "\n",
  );
  expect(check("  const a = 1;\n  const b = 2;", corpus).label).toBe("verified");
  expect(check("function test() {\n\n  const a = 1;", corpus).label).toBe("verified");
});

test("a blank LAST context line still closes its hunk, so the next hunk opens", () => {
  // Counted but not quotable: nothing distinguishes it from the newline a
  // cut-short diff ends on. Counting it is what keeps hunk 2 reachable.
  const corpus = [
    ...rawHead,
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    "",
    "@@ -40,1 +41,2 @@",
    " const y = 9;",
    "+const z = 10;",
  ].join("\n");
  expect(check("const a = 1;\nconst b = 2;", corpus).label).toBe("verified");
  expect(check("const y = 9;\nconst z = 10;", corpus).label).toBe("verified");
});

test("the newline a cut-short diff ended on is not a blank line of code", () => {
  // Cross-family review (codex, 2026-09-10): raw stdout ends in `\n`, siltpoke
  // appends `\n--- stderr ---`, and the empty line between them read as blank
  // context while the header still owed lines.
  const corpus = [...rawHead, "@@ -1,3 +1,3 @@", " const a = 1;", " const b = 2;", "", "--- stderr ---", "warning"].join(
    "\n",
  );
  expect(check("const a = 1;\nconst b = 2;", corpus).label).toBe("verified");
  // The line after `const b = 2;` is not known to exist, so neither is the
  // newline that would end it.
  expect(check("const a = 1;\nconst b = 2;\n", corpus).label).toBe("none_verified");
});

test("a hunk-shaped line in another tool's output is not a hunk", () => {
  // Cross-family review (codex, 2026-09-10): without this, any `@@ -a,b +c,d @@`
  // at column 0 opened a hunk, and the next lines, one column shorter, became
  // quotable — text no tool produced.
  const corpus = [
    `${FILE}(1,1): error TS9999: fixture text below`,
    "@@ -1,2 +1,2 @@",
    " shared diagnostic detail",
    "+added-looking diagnostic detail",
  ].join("\n");
  expect(check("shared diagnostic detail\nadded-looking diagnostic detail", corpus).label).toBe("none_verified");
});

// ---------------------------------------------------------------------------
// siltpoke's own truncation
// ---------------------------------------------------------------------------

// Four consecutive new-side lines of the hunk above, as the file reads them.
const REAL_BLOCK = [
  " * The labels that mean \"nothing was examined\" — as a predicate, because there",
  " * are now two and every consumer that hard-coded the first one would silently",
  " * treat the second as a checked review. TypeScript cannot catch that: both are",
  " * members of the same union, so `=== \"not_checked\"` stays valid and just stops",
].join("\n");

function asSchemaTruncates(s: string): string {
  // Mirrors `truncStr` in src/brain/schema.ts: keep CAP-1 chars, append U+2026.
  return `${s.slice(0, SNIPPET_CAP - 1)}…`;
}

test("a snippet siltpoke cut to the cap is checked on what it kept", () => {
  // The fixture is only meaningful if everything the cut keeps is real text.
  expect(REAL_BLOCK.length).toBeGreaterThanOrEqual(SNIPPET_CAP - 1);
  const truncated = asSchemaTruncates(`${REAL_BLOCK}\n and a long tail the cut throws away`);
  expect(truncated.length).toBe(SNIPPET_CAP);
  expect(check(truncated).label).toBe("verified");
});

test("a cut snippet whose kept part is NOT real stays refused", () => {
  const truncated = asSchemaTruncates("fabricated ".repeat(40));
  expect(truncated.length).toBe(SNIPPET_CAP);
  expect(check(truncated).label).toBe("none_verified");
});

test("a SHORT snippet ending in … is not treated as siltpoke's truncation", () => {
  // Only the exact shape the schema produces is forgiven. A model that writes
  // "isUnchecked(…" itself is eliding, and its prefix alone is not a quote.
  expect(check("export function isUnchecked(…").label).toBe("none_verified");
});
