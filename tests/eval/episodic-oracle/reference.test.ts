import { describe, expect, test } from "bun:test";
import {
  injectEverythingPolicy,
  injectNothingPolicy,
  keywordPolicy,
} from "../../../src/eval/episodic-oracle/reference";
import type { CritiqueScenario, EpisodicEntry } from "../../../src/eval/episodic-oracle/types";

const scenario: CritiqueScenario = {
  id: "s",
  intent: "bugfix",
  files: ["src/auth.ts"],
  summary: "missing null guard caused auth crash",
};
const store: EpisodicEntry[] = [
  { id: "rel", text: "you forgot a null guard in auth before", ts: "2026-06-01T00:00:00Z", confidence: 0.9 },
  { id: "irr", text: "tailwind colors look off on mobile", ts: "2026-06-01T00:00:00Z", confidence: 0.9 },
];

describe("keywordPolicy", () => {
  test("injects the relevant entry, ignores the unrelated one", () => {
    const d = keywordPolicy(scenario, store);
    expect(d.injected).toContain("rel");
    expect(d.injected).not.toContain("irr");
    expect(d.abstained).toBe(false);
  });
  test("abstains when nothing overlaps", () => {
    const d = keywordPolicy(
      { ...scenario, summary: "zzzz qqqq wwww" },
      [{ id: "x", text: "completely different topic", ts: "2026-06-01T00:00:00Z", confidence: 0.5 }],
    );
    expect(d.abstained).toBe(true);
    expect(d.injected).toHaveLength(0);
  });
});

describe("bad / abstain stubs", () => {
  test("injectEverything injects all ids", () => {
    expect(injectEverythingPolicy(scenario, store).injected).toEqual(["rel", "irr"]);
  });
  test("injectNothing always abstains", () => {
    expect(injectNothingPolicy(scenario, store)).toEqual({ injected: [], abstained: true });
  });
});
