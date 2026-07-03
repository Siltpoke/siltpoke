import { describe, test, expect } from "bun:test";
import { isAuthorized, generateSecret } from "../../src/daemon/auth";

describe("auth", () => {
  test("matches the expected secret", () => {
    expect(isAuthorized("abc", "abc")).toBe(true);
  });
  test("rejects mismatched secret of same length", () => {
    expect(isAuthorized("aaaa", "bbbb")).toBe(false);
  });
  test("rejects mismatched secret of different length", () => {
    expect(isAuthorized("abc", "abcd")).toBe(false);
  });
  test("rejects missing/undefined provided header", () => {
    expect(isAuthorized("abc", undefined)).toBe(false);
  });
  test("rejects empty provided header", () => {
    expect(isAuthorized("abc", "")).toBe(false);
  });
  test("generateSecret returns a string with non-trivial length", () => {
    const s = generateSecret();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThanOrEqual(32);
  });
  test("generateSecret returns different secrets each call", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});
