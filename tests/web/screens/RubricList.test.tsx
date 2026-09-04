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

  test("tier badges actually render their fill and foreground", () => {
    // Regression pin: tierBadgeStyle() used to return a CSS STRING that both
    // call sites passed as a `cssText` key inside a JSX style object. Hono
    // silently drops an unrecognised key, so the badges rendered with no
    // background and no color at all — a styling function that looked correct
    // and reached the DOM never. Found while adding rendered-output assertions
    // for the dark-mode token migration.
    const html = String(<RubricList rules={ALL_RUBRIC_RULES} calibration={{}} />);
    const badges = html.match(/<span style="[^"]*font-weight:700[^"]*">T\d<\/span>/g) ?? [];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge).toContain("background:var(--color-");
      expect(badge).toContain("color:var(--color-");
    }
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
