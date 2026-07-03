import { describe, expect, test } from "bun:test";
import { oracleFixtureSchema } from "../../../src/eval/episodic-oracle/types";

const valid = {
  id: "pos-001",
  kind: "positive",
  scenario: { id: "s1", intent: "bugfix", files: ["src/a.ts"], summary: "null guard in auth" },
  store: [{ id: "m1", text: "you forgot a null check last time", ts: "2026-06-01T00:00:00Z", confidence: 0.9 }],
  expect: { must_inject: ["m1"], must_not_inject: [], must_abstain: false },
};

describe("oracleFixtureSchema", () => {
  test("accepts a well-formed fixture", () => {
    const parsed = oracleFixtureSchema.parse(valid);
    expect(parsed.id).toBe("pos-001");
    expect(parsed.must_not_regress).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(() => oracleFixtureSchema.parse({ ...valid, kind: "weird" })).toThrow();
  });

  test("rejects a fixture missing expect", () => {
    const { expect: _omit, ...rest } = valid;
    expect(() => oracleFixtureSchema.parse(rest)).toThrow();
  });
});
