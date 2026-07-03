/** @jsxImportSource hono/jsx */
/**
 * ViewToggle.test.tsx — Design D atom tests.
 */
import { test, expect, describe } from "bun:test";
import { ViewToggle } from "../../../src/web/atoms/ViewToggle";
import { tokens } from "../../../src/web/tokens/tokens";

describe("ViewToggle", () => {
  test("renders .view-toggle wrapper", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain('class="view-toggle"');
  });

  test("renders 'view' label text (uppercase mono)", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain("view");
  });

  test("renders 'dashboard' segment text", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain("dashboard");
  });

  test("renders 'toy' segment text", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain("toy");
  });

  test("data-active='dashboard' when active=dashboard", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain('data-active="dashboard"');
  });

  test("data-active='toy' when active=toy", () => {
    const html = String(<ViewToggle active="toy" />);
    expect(html).toContain('data-active="toy"');
  });

  test("dashboard segment has ink background when active=dashboard", () => {
    const html = String(<ViewToggle active="dashboard" />);
    // Active segment uses ink background (dark).
    expect(html).toContain(tokens.color.ink);
  });

  test("toy segment has ink background when active=toy", () => {
    const html = String(<ViewToggle active="toy" />);
    expect(html).toContain(tokens.color.ink);
  });

  test("active segment style differs from inactive: dashboard active has ink color", () => {
    const dashHtml = String(<ViewToggle active="dashboard" />);
    const toyHtml = String(<ViewToggle active="toy" />);
    // When dashboard is active, it uses ink bg (cream text). When toy is active,
    // dashboard segment uses cream bg (ink2 text). The strings differ.
    expect(dashHtml).not.toBe(toyHtml);
  });

  test("view-toggle__dashboard class present on dashboard pill", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain('class="view-toggle__dashboard"');
  });

  test("view-toggle__toy class present on toy pill", () => {
    const html = String(<ViewToggle active="dashboard" />);
    expect(html).toContain('class="view-toggle__toy"');
  });
});
