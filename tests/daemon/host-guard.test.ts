// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, test, expect } from "bun:test";
import { isAllowedHost } from "../../src/daemon/host-guard";

describe("isAllowedHost", () => {
  test("accepts 127.0.0.1:<port>", () => {
    expect(isAllowedHost("127.0.0.1:9876", 9876)).toBe(true);
  });

  test("accepts localhost:<port>", () => {
    expect(isAllowedHost("localhost:9876", 9876)).toBe(true);
  });

  test("accepts [::1]:<port>", () => {
    expect(isAllowedHost("[::1]:9876", 9876)).toBe(true);
  });

  test("rejects a foreign Host header (DNS-rebinding attempt)", () => {
    expect(isAllowedHost("evil.com", 9876)).toBe(false);
  });

  test("rejects a mismatched port on an otherwise-allowed hostname", () => {
    expect(isAllowedHost("127.0.0.1:1234", 9876)).toBe(false);
  });

  test("rejects a missing Host header", () => {
    expect(isAllowedHost(undefined, 9876)).toBe(false);
    expect(isAllowedHost(null, 9876)).toBe(false);
    expect(isAllowedHost("", 9876)).toBe(false);
  });
});
