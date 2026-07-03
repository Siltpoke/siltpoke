/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Hero } from "../../../src/web/primitives/Hero";

const BASE_PET = {
  name: "siltpoke",
  species: "cat" as const,
  mood: "neutral" as const,
  level: 3,
};

describe("Hero", () => {
  test("renders <section id='hero'> (hx-target anchor)", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('<section');
    expect(html).toContain('id="hero"');
  });

  test("renders greeting text", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('class="hero__greeting"');
    expect(html).toContain("hi.");
  });

  test("happy mood uses upbeat greeting", () => {
    const html = String(<Hero pet={{ ...BASE_PET, mood: "happy" }} />);
    expect(html).toContain("hi!");
  });

  test("sad mood uses subdued greeting", () => {
    const html = String(<Hero pet={{ ...BASE_PET, mood: "sad" }} />);
    expect(html).toContain("…hi.");
  });

  test("sleepy mood has sleepy greeting", () => {
    const html = String(<Hero pet={{ ...BASE_PET, mood: "sleepy" }} />);
    expect(html).toContain("zz");
  });

  test("hungry mood has hungry greeting", () => {
    const html = String(<Hero pet={{ ...BASE_PET, mood: "hungry" }} />);
    expect(html).toContain("hungry");
  });

  test("renders tagline with level + species + name", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('class="hero__tagline"');
    expect(html).toContain("L3");
    expect(html).toContain("cat");
    expect(html).toContain("siltpoke");
  });

  test("renders creature face section", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('class="hero__creature"');
    // Creature outputs a <pre> block
    expect(html).toContain("<pre");
  });

  test("renders 3 action chips (feed / play / pet)", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('data-action="feed"');
    expect(html).toContain('data-action="play"');
    expect(html).toContain('data-action="pet"');
  });

  test("all action chips target #hero for outerHTML swap", () => {
    const html = String(<Hero pet={BASE_PET} />);
    const targetCount = (html.match(/hx-target="#hero"/g) ?? []).length;
    expect(targetCount).toBe(3);
    const swapCount = (html.match(/hx-swap="outerHTML"/g) ?? []).length;
    expect(swapCount).toBe(3);
  });

  test("hero__chips wrapper wraps all chips", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('class="hero__chips"');
  });

  test("renders XP bar when progression provided", () => {
    const html = String(
      <Hero pet={BASE_PET} progression={{ xp: 60, xp_to_next: 100 }} />,
    );
    expect(html).toContain('class="hero__xp"');
    expect(html).toContain('class="hero__xp-fill"');
  });

  test("XP fill width clamps to 100% max", () => {
    const html = String(
      <Hero pet={BASE_PET} progression={{ xp: 200, xp_to_next: 100 }} />,
    );
    // width should be clamped to 100%
    expect(html).toContain("width:100%");
  });

  test("omits XP bar when progression not provided", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).not.toContain("hero__xp");
  });

  test("renders slime species without error", () => {
    const html = String(
      <Hero pet={{ ...BASE_PET, species: "slime" }} />,
    );
    expect(html).toContain('id="hero"');
  });

  test("renders robot species without error", () => {
    const html = String(
      <Hero pet={{ ...BASE_PET, species: "robot" }} />,
    );
    expect(html).toContain('id="hero"');
  });

  test("section has class='hero'", () => {
    const html = String(<Hero pet={BASE_PET} />);
    expect(html).toContain('class="hero"');
  });
});
