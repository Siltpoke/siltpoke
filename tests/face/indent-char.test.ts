// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Install-audit defect [5a], closed as NOT-a-defect on measured evidence.
//
// The audit's concern was that U+2800 BRAILLE PATTERN BLANK is an odd choice
// of indent character that could misalign in a terminal whose font lacks the
// glyph, and asked whether something better-covered could be used instead.
//
// Probed through the real Claude Code statusline on 2026-09-20 — five rows:
// no indent (the ruler), three ASCII spaces, three U+2800, three U+00A0
// (NBSP), three U+2007 (FIGURE SPACE). ASCII spaces, NBSP and FIGURE SPACE
// were ALL stripped back to column zero; only U+2800 kept its indent.
//
// So the renderer strips by the Unicode White_Space property, not by ASCII.
// Every space-like character is therefore unusable, and U+2800 is not a
// preference among alternatives — it is the only character that works.
//
// This file exists so that fact cannot be lost to a tidy-up. The failure it
// guards against is silent: swapping in spaces does not throw, it just makes
// every indented statusline row jump to column zero.
import { describe, expect, test } from "bun:test";
import { composeOutput } from "../../src/face/composer";

const BRAILLE_BLANK = "⠀";

describe("the statusline indent character", () => {
  test("is U+2800, and U+2800 is not whitespace — which is the whole point", () => {
    // If this ever becomes true, U+2800 would be stripped like the rest and the
    // premise of the design is gone. It is a property of Unicode, not of us,
    // so this is a canary, not a policy.
    expect(/\s/u.test(BRAILLE_BLANK)).toBe(false);
    // The characters that ARE whitespace — every one of them measured stripped.
    for (const c of [" ", " ", " ", " "]) {
      expect(/\s/u.test(c)).toBe(true);
    }
  });

  test("blank face rows are indented with U+2800, never with spaces", () => {
    // Two face rows, three inner rows: row 3 has no face, so it is the indented
    // continuation row the audit was looking at.
    const out = composeOutput({
      face: ["(o.o)", "(___)"].join("\n"),
      inner: "one\ntwo\nthree",
      termWidth: 200,
    });
    const continuation = out.split("\n")[2];
    expect(continuation).toBeDefined();
    expect(continuation).toContain("three");
    expect(continuation?.startsWith(BRAILLE_BLANK)).toBe(true);
    // The indent is ONLY braille blanks — a single leading space would be
    // eaten by the renderer and shift the row.
    const indent = continuation?.slice(0, continuation.length - "three".length) ?? "";
    expect(indent.length).toBeGreaterThan(0);
    expect([...indent].every((c) => c === BRAILLE_BLANK)).toBe(true);
  });

  test("rows that DO have a face keep ordinary spaces — only leading padding is special", () => {
    // The strip is leading-only; padding between the face and the bubble is
    // interior, so it stays plain. Pinned so a well-meaning sweep does not
    // convert the whole file to braille blanks and widen every row.
    const out = composeOutput({
      face: ["(o.o)", "(___)"].join("\n"),
      inner: "one\ntwo",
      termWidth: 200,
    });
    const faced = out.split("\n")[0] ?? "";
    expect(faced.startsWith("(")).toBe(true);
    expect(faced).toContain(" ");
  });
});
