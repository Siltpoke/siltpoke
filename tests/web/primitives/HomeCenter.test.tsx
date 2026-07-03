/** @jsxImportSource hono/jsx */
/**
 * HomeCenter.test.tsx — Design D layout tests.
 *
 * Verifies new prop shape: statusLabels, view, greeting, tagline.
 * Legacy statuslinePreview / latestCritique props are dropped.
 */
import { test, expect, describe } from "bun:test";
import { HomeCenter } from "../../../src/web/primitives/HomeCenter";

const SAMPLE_PET = {
  name: "Bangbang",
  species: "cat" as const,
  mood: "happy" as const,
  level: 12,
};

function renderDefault() {
  return String(
    <HomeCenter
      pet={SAMPLE_PET}
      statusLabels={{ left: "awake · happy", right: "last poke · 2m ago" }}
      view="dashboard"
      greeting="hi."
      tagline="siltpoke is watching."
    />,
  );
}

describe("HomeCenter", () => {
  test("renders <section id='hero'> for HTMX swap compat", () => {
    expect(renderDefault()).toContain('id="hero"');
  });

  test("home-center class on root section", () => {
    expect(renderDefault()).toContain("home-center");
  });

  test("renders left status pill text", () => {
    expect(renderDefault()).toContain("awake · happy");
  });

  test("renders right status pill text", () => {
    expect(renderDefault()).toContain("last poke · 2m ago");
  });

  test("renders status pill wrapper (home-center__status-pills)", () => {
    expect(renderDefault()).toContain("home-center__status-pills");
  });

  test("ViewToggle dropped (toy view shelved)", () => {
    const html = renderDefault();
    expect(html).not.toContain("view-toggle");
    expect(html).not.toContain('data-active="dashboard"');
  });

  test("renders greeting text", () => {
    expect(renderDefault()).toContain("hi.");
  });

  test("renders tagline text", () => {
    expect(renderDefault()).toContain("siltpoke is watching.");
  });

  test("renders greeting in home-center__greeting wrapper", () => {
    expect(renderDefault()).toContain("home-center__greeting");
  });

  test("renders creature component (home-center__creature + <pre>)", () => {
    const html = renderDefault();
    expect(html).toContain("home-center__creature");
    expect(html).toContain("<pre");
  });

  test("renders 4 action chips (feed / play / clean / pet)", () => {
    const html = renderDefault();
    expect(html).toContain('data-action="feed"');
    expect(html).toContain('data-action="play"');
    expect(html).toContain('data-action="clean"');
    expect(html).toContain('data-action="pet"');
  });

  test("renders sleep + tease chips (dashboard parity)", () => {
    const html = renderDefault();
    expect(html).toContain('data-action="sleep"');
    expect(html).toContain('data-action="tease"');
  });

  test("action chips have keyCap labels (F / P / C / E / Z / T)", () => {
    const html = renderDefault();
    expect(html).toContain(">F<");
    expect(html).toContain(">P<");
    expect(html).toContain(">C<");
    expect(html).toContain(">E<");
    expect(html).toContain(">Z<");
    expect(html).toContain(">T<");
  });

  test("renders chip row wrapper (home-center__chips)", () => {
    expect(renderDefault()).toContain("home-center__chips");
  });

  test("dotted background-image style is present", () => {
    const html = renderDefault();
    expect(html).toContain("radial-gradient");
    expect(html).toContain("8px 8px");
  });

  test("toy view prop ignored — renders dashboard regardless", () => {
    const html = String(
      <HomeCenter
        pet={SAMPLE_PET}
        statusLabels={{ left: "awake · happy", right: "last poke · 2m ago" }}
        view="toy"
        greeting="hi."
        tagline="custom tagline here"
      />,
    );
    // Dashboard markers still present even with view=toy.
    expect(html).toContain("home-center__creature");
    expect(html).toContain("home-center__chips");
  });

  test("custom tagline renders in output", () => {
    const html = String(
      <HomeCenter
        pet={SAMPLE_PET}
        statusLabels={{ left: "sleeping · neutral", right: "never" }}
        view="dashboard"
        greeting="hey."
        tagline="the await is missing on line 47 again."
      />,
    );
    expect(html).toContain("the await is missing on line 47 again.");
  });
});
