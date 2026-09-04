// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { mustResolve, nextLadderStep } from "../../src/quiz/resolution-floor";

const modules = ["src/daemon/", "src/web/", "src/repo-graph/"];

describe("mustResolve — the floor", () => {
  test("exact last-segment name resolves", () => {
    expect(mustResolve("daemon", modules)).toBe(true);
  });
  test("obvious alias (full path) resolves", () => {
    expect(mustResolve("src/repo-graph/", modules)).toBe(true);
  });
  test("genuinely out-of-graph name does not resolve", () => {
    expect(mustResolve("kubernetes-operator", modules)).toBe(false);
  });
});

describe("nextLadderStep — never loops", () => {
  test("null → alias → locate → move_on, then stays", () => {
    expect(nextLadderStep(null)).toBe("alias");
    expect(nextLadderStep("alias")).toBe("locate");
    expect(nextLadderStep("locate")).toBe("move_on");
    expect(nextLadderStep("move_on")).toBe("move_on");
  });
});
