/**
 * Defect [45] — a symbol's one-line purpose is the first SENTENCE of its doc
 * comment, not its first physical line.
 *
 * Doc comments are wrapped at ~80 columns, so the first line of a real one
 * usually stops mid-sentence. The trace card showed `confineToRepo` as
 * "Drop changed-file paths that do not resolve inside `cwd` — see".
 *
 * Run: bun test tests/repo-graph/doc-comment-first-sentence.test.ts
 */
import { describe, expect, test } from "bun:test";
import { parseFirstDocComment } from "../../src/repo-graph/doc-comment-parser";

const doc = (...lines: string[]): string => ["/**", ...lines.map((l) => ` * ${l}`.trimEnd()), " */", ""].join("\n");

describe("parseFirstDocComment — a sentence wrapped over several lines", () => {
  test("the reported case: the sentence continues on the next line", () => {
    const src = doc(
      "Drop changed-file paths that do not resolve inside `cwd` — see",
      "`ExtractChangedFilesOpts.confineToCwd` for what gets in and why.",
      "",
      "FAIL-SAFE: if confinement would remove EVERY path, none are removed.",
    );
    expect(parseFirstDocComment(src)).toBe(
      "Drop changed-file paths that do not resolve inside `cwd` — see `ExtractChangedFilesOpts.confineToCwd` for what gets in and why.",
    );
  });

  test("stops at the end of the first sentence, not the end of the paragraph", () => {
    const src = doc("Resolve the plugin root. Falls back to the", "environment variable when the pointer is missing.");
    expect(parseFirstDocComment(src)).toBe("Resolve the plugin root.");
  });

  test("a first paragraph with no full stop is returned whole", () => {
    expect(parseFirstDocComment(doc("Cheap node-existence check", "for pinned chat turns", "", "Second paragraph."))).toBe(
      "Cheap node-existence check for pinned chat turns",
    );
  });

  test("a blank line ends the paragraph even without a full stop", () => {
    expect(parseFirstDocComment(doc("Heading without a stop", "", "Body sentence."))).toBe("Heading without a stop");
  });

  test("a tag line ends the paragraph", () => {
    expect(parseFirstDocComment(doc("Compute the digest of", "@param input the text"))).toBe("Compute the digest of");
  });
});

describe("parseFirstDocComment — what does not end a sentence", () => {
  test("a dot inside backticks", () => {
    // The capital after the dot matters: a lowercase word there would be
    // kept by the "sentence goes on" rule and this test would not see the
    // backtick rule at all.
    expect(parseFirstDocComment(doc("Reads `meta.json. Old` once and", "caches it. Then returns."))).toBe(
      "Reads `meta.json. Old` once and caches it.",
    );
  });

  test("a dot with no space after it (a path, a version, a property)", () => {
    expect(parseFirstDocComment(doc("Bumps v1.2 of src/a.ts and", "writes it back. Done."))).toBe(
      "Bumps v1.2 of src/a.ts and writes it back.",
    );
  });

  test("e.g. / i.e. never end one, even before a capital", () => {
    expect(parseFirstDocComment(doc("Handles odd hosts, e.g. Antigravity, i.e. the ones", "without a cwd. Next sentence."))).toBe(
      "Handles odd hosts, e.g. Antigravity, i.e. the ones without a cwd.",
    );
  });

  test("etc. ends one only when a new sentence follows", () => {
    expect(parseFirstDocComment(doc("Covers agy, codex, etc. and more. Next."))).toBe("Covers agy, codex, etc. and more.");
    expect(parseFirstDocComment(doc("Covers agy, codex, etc. Next sentence."))).toBe("Covers agy, codex, etc.");
  });

  test("a dotted initialism (U.S., a.m.) and vs. do not end one", () => {
    expect(parseFirstDocComment(doc("The U.S. team wins at 9 a.m. vs. Codex. More."))).toBe(
      "The U.S. team wins at 9 a.m. vs. Codex.",
    );
  });

  test("an ellipsis followed by a lowercase word", () => {
    expect(parseFirstDocComment(doc("Waits... then continues. Next."))).toBe("Waits... then continues.");
  });

  test("one stray backtick does not swallow the rest of the paragraph", () => {
    expect(parseFirstDocComment(doc("Uses the ` char to quote. Then more.", "Third line."))).toBe("Uses the ` char to quote.");
  });

  test("a full-width stop ends a sentence without a following space", () => {
    expect(parseFirstDocComment(doc("先查清新用户装到的是什么。再修产品。"))).toBe("先查清新用户装到的是什么。");
  });
});

describe("parseFirstDocComment — lists and code fences", () => {
  test("a comment that opens with a numbered item keeps that line, not `1.`", () => {
    expect(parseFirstDocComment(doc("1. First step", "2. Second step"))).toBe("1. First step");
  });

  test("a comment that opens with a bullet keeps that one bullet", () => {
    expect(parseFirstDocComment(doc("- item one", "- item two."))).toBe("- item one");
  });

  test("a list right under the prose is not joined onto it", () => {
    expect(parseFirstDocComment(doc("Steps:", "1. do a", "2. do b"))).toBe("Steps:");
    expect(parseFirstDocComment(doc("Order of checks", "- PATH", "- the pointer file"))).toBe("Order of checks");
  });

  test("a code fence ends the prose; a comment that opens with one has no purpose", () => {
    expect(parseFirstDocComment(doc("Call it like this", "```ts", "foo();", "```"))).toBe("Call it like this");
    expect(parseFirstDocComment(doc("```ts", "foo();", "```"))).toBe("");
  });

  test("a number at the end of a sentence still ends it", () => {
    expect(parseFirstDocComment(doc("Retries up to 3 times. Then gives up."))).toBe("Retries up to 3 times.");
  });
});

describe("parseFirstDocComment — comment layout", () => {
  test("text on the opening line is part of the sentence", () => {
    expect(parseFirstDocComment("/** Resolve the root\n * of the plugin. More.\n */\n")).toBe("Resolve the root of the plugin.");
  });

  test("a closing marker on a text line is not part of the text", () => {
    expect(parseFirstDocComment("/**\n * Clear the cache so the page\n * reflects the file. */\n")).toBe(
      "Clear the cache so the page reflects the file.",
    );
  });

  test("CRLF line endings", () => {
    expect(parseFirstDocComment("/**\r\n * Drop the paths — see\r\n * the options.\r\n */\r\n")).toBe("Drop the paths — see the options.");
  });
});

describe("parseFirstDocComment — length", () => {
  test("a very long first sentence is cut at a word, with an ellipsis", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const out = parseFirstDocComment(doc(words));
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.endsWith("…")).toBe(true);
    // cut between words: what precedes the ellipsis is a whole word.
    expect(out).toMatch(/ word\d+…$/);
    expect(words.startsWith(out.slice(0, -1))).toBe(true);
  });

  test("a single-line comment that is only a tag is a pragma, not a purpose", () => {
    // 100+ files open with this; it used to be shown as the file's description.
    expect(parseFirstDocComment("/** @jsxImportSource hono/jsx */\nexport const x = 1;\n")).toBe("");
  });

  test("a single-line comment gets the same rule", () => {
    expect(parseFirstDocComment("/** First one. Second one. */\nexport const x = 1;\n")).toBe("First one.");
  });
});
