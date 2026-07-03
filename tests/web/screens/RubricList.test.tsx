/** @jsxImportSource hono/jsx */
/**
 * RubricList screen smoke tests
 */
import { test, expect, describe } from "bun:test";
import { RubricList } from "../../../src/web/screens/RubricList";
import { ALL_RUBRIC_RULES } from "../../../src/critic/rubric/rules";

describe("RubricList screen", () => {
  test("renders Dashboard shell", () => {
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);
    expect(html).toContain("data-sidebar");
    expect(html).toContain("WORK");
  });

  test("renders expected content: Rule Explorer header and rule count", () => {
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);
    expect(html).toContain("Rule Explorer");
    expect(html).toContain(`${ALL_RUBRIC_RULES.length} rules`);
  });

  test.skip("activeSection is 'rubric'", () => {
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);
    // The active nav entry renders aria-current="page"
    expect(html).toContain('aria-current="page"');
    // rubric link href
    expect(html).toContain('href="/rubric"');
  });

  test("shows calibration hit counts when provided", () => {
    const calibration = { "god-file": 42, "magic-number": 1607 };
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={calibration} />);
    expect(html).toContain("42 hits");
    expect(html).toContain("1607 hits");
  });

  test("renders tier breakdown chips T1 / T2 / T3", () => {
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);
    expect(html).toContain("T1");
    expect(html).toContain("T2");
    expect(html).toContain("T3");
  });
});
