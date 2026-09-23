// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { detectInstalledReviewers, formatDetect } from "../../src/cli/brain-detect";

// Setup offers cross-family review only when another reviewer CLI is really on
// PATH — this is the one fact that offer needs.
const onPath = (present: readonly string[]) => (cmd: string) =>
  present.includes(cmd) ? `/usr/local/bin/${cmd}` : null;

describe("detectInstalledReviewers — which other reviewer CLIs are installed", () => {
  test("reports every installed foreign family, by family name, in registry order", () => {
    expect(detectInstalledReviewers(onPath(["codebuddy", "codex", "qodercli"]))).toEqual([
      "codex",
      "qoder",
      "codebuddy",
    ]);
  });

  test("an absent binary is left out", () => {
    expect(detectInstalledReviewers(onPath(["codex"]))).toEqual(["codex"]);
  });

  test("nothing installed → an empty list", () => {
    expect(detectInstalledReviewers(onPath([]))).toEqual([]);
  });

  test("never reports claude, even when a `claude` binary is on PATH", () => {
    expect(detectInstalledReviewers(onPath(["claude", "agy"]))).toEqual(["agy"]);
  });
});

describe("formatDetect — the line setup parses", () => {
  test("is one JSON object with an `installed` array", () => {
    expect(JSON.parse(formatDetect(onPath(["agy"])))).toEqual({ installed: ["agy"] });
    expect(formatDetect(onPath([]))).toBe('{"installed":[]}');
  });
});
