/** @jsxImportSource hono/jsx */
/**
 * VitalsPanel tests — reshaped.
 *
 * New shape: 2x2 grid (mood/hunger/energy/bond), each with a filled-area
 * sparkline and display value. Replaces the old 3-tile actions/tokens/brain
 * vertical layout.
 */
import { test, expect, describe } from "bun:test";
import { VitalsPanel } from "../../../src/web/primitives/VitalsPanel";

const SAMPLE_VITALS = {
  mood:   [5, 5, 6, 6, 7, 6, 6],
  hunger: [3, 4, 5, 6, 7, 5, 4],
  energy: [6, 7, 7, 8, 7, 7, 7],
  bond:   [7, 7, 7, 8, 8, 8, 8],
};

const SAMPLE_VALUES = {
  mood:   "6/10",
  hunger: "fed",
  energy: "7/10",
  bond:   "+0.4",
};

describe("VitalsPanel (Wave 1.5b reshaped)", () => {
  test("renders VITALS header", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain("VITALS");
  });

  test("renders 'last 7d' sub-header", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain("last 7d");
  });

  test("renders 4 vitals tiles", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    const tileMatches = html.match(/class="vitals-tile"/g) ?? [];
    expect(tileMatches).toHaveLength(4);
  });

  test("renders all 4 data-vital attributes (mood/hunger/energy/bond)", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain('data-vital="mood"');
    expect(html).toContain('data-vital="hunger"');
    expect(html).toContain('data-vital="energy"');
    expect(html).toContain('data-vital="bond"');
  });

  test("renders tile labels", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain("mood");
    expect(html).toContain("hunger");
    expect(html).toContain("energy");
    expect(html).toContain("bond");
  });

  test("renders display values from values prop", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain("6/10");
    expect(html).toContain("fed");
    expect(html).toContain("7/10");
    expect(html).toContain("+0.4");
  });

  test("renders 4 sparklines (4 <svg> elements)", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    const svgMatches = html.match(/<svg/g) ?? [];
    expect(svgMatches).toHaveLength(4);
  });

  test("sparklines carry aria-label with vital name", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain('aria-label="mood last 7 days"');
    expect(html).toContain('aria-label="hunger last 7 days"');
    expect(html).toContain('aria-label="energy last 7 days"');
    expect(html).toContain('aria-label="bond last 7 days"');
  });

  test("all-zero values render 4 tiles + 4 sparklines (no crash)", () => {
    const zeros = {
      mood:   [0, 0, 0, 0, 0, 0, 0],
      hunger: [0, 0, 0, 0, 0, 0, 0],
      energy: [0, 0, 0, 0, 0, 0, 0],
      bond:   [0, 0, 0, 0, 0, 0, 0],
    };
    const html = String(<VitalsPanel vitals={zeros} values={SAMPLE_VALUES} />);
    expect((html.match(/class="vitals-tile"/g) ?? []).length).toBe(4);
    expect((html.match(/<svg/g) ?? []).length).toBe(4);
  });

  test("empty arrays render 4 tiles + 4 sparklines (graceful fallback)", () => {
    const empty = { mood: [], hunger: [], energy: [], bond: [] };
    const html = String(<VitalsPanel vitals={empty} values={SAMPLE_VALUES} />);
    expect((html.match(/class="vitals-tile"/g) ?? []).length).toBe(4);
    expect((html.match(/<svg/g) ?? []).length).toBe(4);
  });

  test("vitals-panel class is on the root element", () => {
    const html = String(<VitalsPanel vitals={SAMPLE_VITALS} values={SAMPLE_VALUES} />);
    expect(html).toContain('class="vitals-panel"');
  });
});
