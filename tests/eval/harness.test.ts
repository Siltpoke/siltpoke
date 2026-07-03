import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadFixtures, runFixture, type Fixture } from "../../src/eval/harness";

const FIXTURES_DIR = join(import.meta.dir, "../../src/eval/fixtures");

// ── loadFixtures ─────────────────────────────────────────────────────────────

describe("loadFixtures", () => {
  it("loads all JSON fixtures from the fixtures directory", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of fixtures) {
      expect(f.id).toBeTruthy();
      expect(f.assertions).toBeInstanceOf(Array);
    }
  });

  it("each fixture has required fields", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    for (const f of fixtures) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.description).toBe("string");
      expect(typeof f.intent_expected).toBe("string");
      expect(typeof f.input).toBe("object");
      expect(Array.isArray(f.assertions)).toBe(true);
    }
  });
});

// ── runFixture ───────────────────────────────────────────────────────────────

describe("runFixture", () => {
  const passingMock = async (_input: Record<string, unknown>) =>
    ({
      intent: { classification: "bugfix", confidence: 0.9 },
      evidence: [{ rule_id: "aws-access-key" }, { rule_id: "test-gap" }],
      critique_for_claude: "Suggested change: verify null guard.",
    }) as Record<string, unknown>;

  const failingMock = async (_input: Record<string, unknown>) =>
    ({
      intent: { classification: "feature" },
      evidence: [],
      critique_for_claude: "Consider refactoring the whole module.",
    }) as Record<string, unknown>;

  it("passes a fixture when all assertions hold", async () => {
    const fixture: Fixture = {
      id: "test-pass",
      description: "Should pass all assertions",
      intent_expected: "bugfix",
      input: { user_message: "fix crash" },
      assertions: [
        { type: "intent_classification_equals", value: "bugfix" },
        { type: "critique_does_not_contain_word", value: "refactor" },
        { type: "trigger_rule_id_prefix", value: "aws" },
        { type: "trigger_rule_id", value: "test-gap" },
      ],
    };

    const result = await runFixture(fixture, passingMock);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("fails a fixture when an assertion is violated", async () => {
    const fixture: Fixture = {
      id: "test-fail-refactor",
      description: "critique_for_claude must not say 'refactor'",
      intent_expected: "bugfix",
      input: { user_message: "fix crash" },
      assertions: [{ type: "critique_does_not_contain_word", value: "refactor" }],
    };

    const result = await runFixture(fixture, failingMock);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("refactor");
  });

  it("reports an unknown assertion type as a failure", async () => {
    const fixture: Fixture = {
      id: "test-unknown-assertion",
      description: "Unknown assertion type should be reported as failure",
      intent_expected: "bugfix",
      input: { user_message: "fix crash" },
      assertions: [{ type: "no_such_assertion_type", value: "whatever" }],
    };

    const result = await runFixture(fixture, passingMock);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("unknown assertion type");
  });
});
