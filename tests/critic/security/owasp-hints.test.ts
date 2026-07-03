import { describe, test, expect } from "bun:test";
import { collectOwaspHints } from "../../../src/critic/security/owasp-hints";

describe("collectOwaspHints", () => {
  test("auth-handler file pattern triggers Broken Authentication hint", () => {
    const hints = collectOwaspHints(["src/auth/login.ts"]);
    expect(hints.some((h) => h.owasp_id === "A07")).toBe(true);
  });

  test("upload/file-handler triggers Injection + Path Traversal hints", () => {
    const hints = collectOwaspHints(["src/api/upload-handler.ts"]);
    expect(hints.some((h) => h.owasp_id === "A03")).toBe(true);
  });

  test("plain util file gets no hints", () => {
    expect(collectOwaspHints(["src/utils/format-date.ts"])).toHaveLength(0);
  });

  test("api route file triggers Broken Access Control hint", () => {
    const hints = collectOwaspHints(["src/api/users.ts"]);
    expect(hints.some((h) => h.owasp_id === "A01")).toBe(true);
  });

  test("database file triggers SQL Injection hint", () => {
    const hints = collectOwaspHints(["src/database/user-repository.ts"]);
    expect(hints.some((h) => h.owasp_id === "A03")).toBe(true);
  });

  test("env/config file triggers Cryptographic Failures hint", () => {
    const hints = collectOwaspHints(["src/config/secrets.ts"]);
    expect(hints.some((h) => h.owasp_id === "A02")).toBe(true);
  });

  test("deduplicates: same file+owasp_id pair not emitted twice", () => {
    const hints = collectOwaspHints(["src/auth/login.ts"]);
    const a07hints = hints.filter((h) => h.owasp_id === "A07" && h.matched_file === "src/auth/login.ts");
    expect(a07hints.length).toBe(1);
  });

  test("multiple files produce hints for each relevant file", () => {
    const hints = collectOwaspHints(["src/auth/login.ts", "src/utils/format-date.ts"]);
    const loginHints = hints.filter((h) => h.matched_file === "src/auth/login.ts");
    const utilHints = hints.filter((h) => h.matched_file === "src/utils/format-date.ts");
    expect(loginHints.length).toBeGreaterThan(0);
    expect(utilHints.length).toBe(0);
  });

  test("empty file list returns no hints", () => {
    expect(collectOwaspHints([])).toHaveLength(0);
  });
});
