// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// numeric-equivalence — deterministic numeric-difference guard.
//
// Pairs below are the REAL runner-visible pairs from the eval calibration
// (eval report): claim = the
// extractor's cached fact text, candidate = the stored fact text. The guard's
// false-positive direction is SAFE by design — a wrongly-fired guard just
// downgrades contradict→add, so the claim lands as a coexisting, visible fact
// (no retirement, no data loss); a miss falls through to the ladder.
import { describe, expect, test } from "bun:test";
import { numericallyEquivalent } from "../../src/memory/numeric-equivalence";

describe("numericallyEquivalent", () => {
  test("zh numeric trap (eval nt-zh-01): 3 只猫 vs 2 只猫 → true", () => {
    // Cached extractor claim "有 3 只猫" is subject-dropped; the containment
    // metric tolerates the fragment-vs-canonical asymmetry (score exactly 0.6).
    expect(numericallyEquivalent("有 3 只猫", "用户养了 2 只猫")).toBe(true);
  });

  test("zh numeric trap (eval nt-zh-02): run frequency differs → true", () => {
    expect(numericallyEquivalent("每周跑步 5 次", "用户每周跑步 3 次")).toBe(true);
  });

  test("zh numeric trap (eval nt-zh-04): years of experience differ → true", () => {
    expect(numericallyEquivalent("后端开发经验 8 年", "用户做后端开发 5 年了")).toBe(true);
  });

  test("en monitors case (eval nt-en-01 message shape) → true", () => {
    expect(numericallyEquivalent("I have 3 monitors on my desk", "User has 2 monitors")).toBe(
      true,
    );
  });

  test("en team-size case (eval nt-en-02) → true", () => {
    expect(numericallyEquivalent("User's team is 6 people", "User's team has 4 people")).toBe(
      true,
    );
  });

  test("same numbers on both sides → false (not a numeric-DIFFERENCE case)", () => {
    expect(numericallyEquivalent("我有 2 只猫", "用户养了 2 只猫")).toBe(false);
  });

  test("shared zh numeral in ordinary words → false (eval ce-zh-06 regression fence)", () => {
    // Both sides carry "一" (一家) — identical token sequences, so this TRUE
    // contradiction is protected from the guard by the same-numbers early exit.
    expect(numericallyEquivalent("在一家AI创业公司做后端", "用户在一家银行工作")).toBe(false);
  });

  test("no numbers on either side → false", () => {
    expect(numericallyEquivalent("用户是猫派", "用户是狗派")).toBe(false);
  });

  test("number on one side only → false", () => {
    expect(numericallyEquivalent("我有 3 只猫", "用户喜欢猫")).toBe(false);
  });

  test("genuinely different claims that both carry numbers → false", () => {
    expect(numericallyEquivalent("我有3只猫", "用户住在2楼")).toBe(false);
  });

  test("90后 vs 00后 → true via short-residue equality fallback", () => {
    // Residues are both the single char "后" (< 2 chars → strict equality).
    // Note this downgrade is the SAFE direction even though 90后/00后 is
    // arguably a true contradiction: the new claim still lands as a visible
    // coexisting add — no retirement without high-precision evidence.
    expect(numericallyEquivalent("用户是90后", "用户是00后")).toBe(true);
  });

  test("short residues that differ → false (equality fallback, not similarity)", () => {
    expect(numericallyEquivalent("3 楼", "2 层")).toBe(false);
  });

  test("zh numerals and fullwidth digits count as numeric tokens", () => {
    expect(numericallyEquivalent("用户养了三只猫", "用户养了两只猫")).toBe(true);
    expect(numericallyEquivalent("用户养了３只猫", "用户养了２只猫")).toBe(true);
  });

  test("decimals are one token", () => {
    expect(numericallyEquivalent("用户身高 1.75 米", "用户身高 1.68 米")).toBe(true);
  });

  test("empty / whitespace inputs → false", () => {
    expect(numericallyEquivalent("", "")).toBe(false);
    expect(numericallyEquivalent("  ", "3")).toBe(false);
  });
});
