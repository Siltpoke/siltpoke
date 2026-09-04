// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { canonicalKey, RootEscapeError } from "../../src/repo-graph/seen-path";

describe("canonicalKey", () => {
  test("strips leading ./", () => expect(canonicalKey("./src/a.ts")).toBe("src/a.ts"));
  test("posix-normalizes backslashes", () => expect(canonicalKey("src\\a.ts")).toBe("src/a.ts"));
  test("normalizes ..", () => expect(canonicalKey("src/x/../a.ts")).toBe("src/a.ts"));
  test("NFC-normalizes", () => expect(canonicalKey("café/a.ts")).toBe("café/a.ts".normalize("NFC")));
  test("idempotent", () => expect(canonicalKey(canonicalKey("./src/a.ts"))).toBe("src/a.ts"));

  // C10 edges
  test("strips a leading /", () => expect(canonicalKey("/src/a.ts")).toBe("src/a.ts"));
  test("collapses repeated slashes", () => expect(canonicalKey("a//b.ts")).toBe("a/b.ts"));
  test("collapses repeated slashes with leading /", () => expect(canonicalKey("//a//b.ts")).toBe("a/b.ts"));
  test("normalizes bare .", () => expect(canonicalKey(".")).toBe(""));
  test("normalizes empty string", () => expect(canonicalKey("")).toBe(""));
  test("idempotent for . and empty", () => {
    expect(canonicalKey(canonicalKey("."))).toBe("");
    expect(canonicalKey(canonicalKey(""))).toBe("");
  });

  test("rejects a root-escaping .. path", () => {
    expect(() => canonicalKey("../../escape.ts")).toThrow(RootEscapeError);
  });
  test("rejects a bare ..", () => {
    expect(() => canonicalKey("..")).toThrow(RootEscapeError);
  });
  test("rejects a single-level escape", () => {
    expect(() => canonicalKey("../escape.ts")).toThrow(RootEscapeError);
  });
  test("idempotent (no reject) for already-safe nested path", () => {
    expect(canonicalKey(canonicalKey("src/x/../a.ts"))).toBe("src/a.ts");
  });

  // Fix round 1 (review 2026-07-27): a leading `/` must NOT let Node's
  // absolute-path normalize() pre-empt the root-escape reject — the exact
  // same escape string with `/` prepended must hit the SAME reject path as
  // the unprefixed form, not be silently accepted+transformed.
  test("rejects a leading-/ double-level escape (bypass regression)", () => {
    expect(() => canonicalKey("/../../x.ts")).toThrow(RootEscapeError);
  });
  test("rejects a leading-/ single-level escape (bypass regression)", () => {
    expect(() => canonicalKey("/../x.ts")).toThrow(RootEscapeError);
  });
  test("a plain leading / with no escape is still stripped, not rejected", () => {
    expect(canonicalKey("/src/a.ts")).toBe("src/a.ts");
  });
});
