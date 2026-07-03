/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { RubricActivityPanel } from "../../../src/web/primitives/RubricActivityPanel";
import type { RubricSummary } from "../../../src/web/primitives/RubricActivityPanel";

const SUMMARY: RubricSummary = {
  totalRules: 13,
  topByTriggers: [
    { rule_id: "magic-number", count: 1607 },
    { rule_id: "god-function", count: 105 },
    { rule_id: "deep-nesting", count: 73 },
  ],
};

describe("RubricActivityPanel", () => {
  test("renders RUBRIC header", () => {
    const html = String(<RubricActivityPanel rubricSummary={null} />);
    expect(html).toContain("RUBRIC");
  });

  test("has rubric-activity-panel class on root element", () => {
    const html = String(<RubricActivityPanel rubricSummary={null} />);
    expect(html).toContain('class="rubric-activity-panel"');
  });

  test("renders empty state when null", () => {
    const html = String(<RubricActivityPanel rubricSummary={null} />);
    expect(html).toContain("no calibration data");
  });

  test("shows view all link", () => {
    const html = String(<RubricActivityPanel rubricSummary={null} />);
    expect(html).toContain('href="/rubric"');
    expect(html).toContain("view all");
  });

  test("shows total rules count when data provided", () => {
    const html = String(<RubricActivityPanel rubricSummary={SUMMARY} />);
    expect(html).toContain("13 rules loaded");
  });

  test("shows top 3 rules by trigger count", () => {
    const html = String(<RubricActivityPanel rubricSummary={SUMMARY} />);
    expect(html).toContain("magic-number");
    expect(html).toContain("1607");
    expect(html).toContain("god-function");
    expect(html).toContain("105");
    expect(html).toContain("deep-nesting");
    expect(html).toContain("73");
  });

  test("does not show more than 3 rules", () => {
    const longSummary: RubricSummary = {
      totalRules: 5,
      topByTriggers: [
        { rule_id: "rule-a", count: 500 },
        { rule_id: "rule-b", count: 400 },
        { rule_id: "rule-c", count: 300 },
        { rule_id: "rule-d", count: 200 },
      ],
    };
    const html = String(<RubricActivityPanel rubricSummary={longSummary} />);
    expect(html).toContain("rule-a");
    expect(html).toContain("rule-c");
    expect(html).not.toContain("rule-d");
  });
});
