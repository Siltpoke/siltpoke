/**
 * critiques.test.ts — MOCK_CRITIQUES fixture validity.
 *
 * Ensures the mock data matches the Critique interface contract.
 */
import { test, expect, describe } from "bun:test";
import { MOCK_CRITIQUES } from "../../../../src/web/_shared/mocks/critiques";

const VALID_TAGS = ["bug", "style", "lint", "design"] as const;

describe("MOCK_CRITIQUES fixture", () => {
  test("exports an array with 3 entries", () => {
    expect(Array.isArray(MOCK_CRITIQUES)).toBe(true);
    expect(MOCK_CRITIQUES).toHaveLength(3);
  });

  test("each critique has required fields: id, tag, text, file, line, ts", () => {
    for (const c of MOCK_CRITIQUES) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.tag).toBe("string");
      expect(typeof c.text).toBe("string");
      expect(typeof c.file).toBe("string");
      expect(typeof c.line).toBe("number");
      expect(typeof c.ts).toBe("string");
    }
  });

  test("all tags are valid CritiqueTag values", () => {
    for (const c of MOCK_CRITIQUES) {
      expect(VALID_TAGS).toContain(c.tag as typeof VALID_TAGS[number]);
    }
  });

  test("first critique is a bug tag", () => {
    expect(MOCK_CRITIQUES[0]?.tag).toBe("bug");
  });

  test("second critique is a style tag", () => {
    expect(MOCK_CRITIQUES[1]?.tag).toBe("style");
  });

  test("third critique is a lint tag", () => {
    expect(MOCK_CRITIQUES[2]?.tag).toBe("lint");
  });

  test("first critique text matches fixture", () => {
    expect(MOCK_CRITIQUES[0]?.text).toBe("missing await on db query");
  });

  test("first critique file is src/critic.tsx", () => {
    expect(MOCK_CRITIQUES[0]?.file).toBe("src/critic.tsx");
  });

  test("first critique line is 88", () => {
    expect(MOCK_CRITIQUES[0]?.line).toBe(88);
  });

  test("all ids are unique", () => {
    const ids = MOCK_CRITIQUES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all ts fields are parseable ISO timestamp strings", () => {
    for (const c of MOCK_CRITIQUES) {
      expect(() => new Date(c.ts)).not.toThrow();
      // Timestamps are valid if they parse to a finite time
      expect(Number.isFinite(new Date(c.ts).getTime())).toBe(true);
    }
  });

  test("all line numbers are positive integers", () => {
    for (const c of MOCK_CRITIQUES) {
      expect(c.line).toBeGreaterThan(0);
      expect(Number.isInteger(c.line)).toBe(true);
    }
  });
});
