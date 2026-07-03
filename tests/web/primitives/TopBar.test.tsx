/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { TopBar } from "../../../src/web/primitives/TopBar";
import { tokens } from "../../../src/web/tokens/tokens";

const FULL_PROPS = {
  brand: "siltpoke",
  petName: "Bangbang",
  petMeta: "L3 · cat",
  badges: [
    { id: "well-fed", label: "well-fed", tone: "good" as const },
    { id: "dressed", label: "since dressed", value: "22 hrs", tone: "neutral" as const },
    { id: "today", label: "today", value: "3 new", tone: "good" as const },
  ],
  profile: { initials: "AB", name: "Alex" },
};

describe("TopBar", () => {
  test("renders <header> (implicit banner landmark)", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain("<header");
    expect(html).toContain('class="topbar"');
  });

  test("badges container has id='topbar-badges' for Wave 2 HTMX OOB-swap target", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain('id="topbar-badges"');
  });

  test("renders brand text", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain(">siltpoke<");
    expect(html).toContain('class="topbar__brand"');
  });

  test("renders pet name + meta in their own spans", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain('class="topbar__pet-name"');
    expect(html).toContain(">Bangbang<");
    expect(html).toContain('class="topbar__pet-meta"');
    expect(html).toContain("L3 · cat");
  });

  test("renders all 3 badges with labels", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    const badgeCount = (html.match(/class="topbar__badge"/g) ?? []).length;
    expect(badgeCount).toBe(3);
    expect(html).toContain(">well-fed<");
    expect(html).toContain(">since dressed<");
    expect(html).toContain(">today<");
  });

  test("renders badge values when present", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain(">22 hrs<");
    expect(html).toContain(">3 new<");
  });

  test("omits badge value span when value undefined", () => {
    const html = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok", tone: "good" }]} />,
    );
    expect(html).not.toContain("topbar__badge-value");
  });

  test("good tone badge uses moss color", () => {
    const html = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok", tone: "good" }]} />,
    );
    expect(html).toContain(tokens.color.moss);
  });

  test("warn tone badge uses amber color", () => {
    const html = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok", tone: "warn" }]} />,
    );
    expect(html).toContain(tokens.color.amber);
  });

  test("neutral tone (default) uses ink3 color", () => {
    const html = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok" }]} />,
    );
    expect(html).toContain(tokens.color.ink3);
  });

  test("badge data-* attributes for testability", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain('data-badge-id="well-fed"');
    expect(html).toContain('data-badge-tone="good"');
    expect(html).toContain('data-badge-tone="neutral"');
  });

  test("renders profile chip with initials when provided", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain('class="topbar__profile"');
    expect(html).toContain(">AB<");
    expect(html).toContain('data-profile-name="Alex"');
  });

  test("profile chip carries aria-label + title with name (a11y accessible-name)", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain('aria-label="Profile: Alex"');
    expect(html).toContain('title="Alex"');
  });

  test("profile chip aria-label falls back to initials when name omitted", () => {
    const html = String(<TopBar {...FULL_PROPS} profile={{ initials: "AB" }} />);
    expect(html).toContain('aria-label="Profile: AB"');
    expect(html).toContain('title="AB"');
  });

  test("warn tone uses distinct background (paperD) vs good (cream)", () => {
    const goodHtml = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok", tone: "good" }]} />,
    );
    const warnHtml = String(
      <TopBar {...FULL_PROPS} badges={[{ id: "x", label: "ok", tone: "warn" }]} />,
    );
    expect(warnHtml).toContain(tokens.color.paperD);
    // good tone does not use paperD on the badge
    expect(goodHtml).not.toMatch(/topbar__badge[^"]*"[^>]*background:#e8dec7/);
  });

  test("omits profile chip when profile prop absent", () => {
    const html = String(<TopBar {...FULL_PROPS} profile={undefined} />);
    expect(html).not.toContain("topbar__profile");
  });

  test("renders empty badges array without crash", () => {
    const html = String(<TopBar {...FULL_PROPS} badges={[]} />);
    expect(html).toContain("<header");
    expect(html).not.toContain('class="topbar__badge"');
  });

  test("badges flex-grow pushes profile to right via margin-left:auto", () => {
    const html = String(<TopBar {...FULL_PROPS} />);
    expect(html).toContain("margin-left:auto");
  });
});
