/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { SettingsRow } from "../../../src/web/primitives/SettingsRow";
import { tokens } from "../../../src/web/tokens/tokens";

describe("SettingsRow", () => {
  test("stacked mode renders label", () => {
    const html = String(<SettingsRow label="Run on every save" />);
    expect(html).toContain("Run on every save");
  });

  test("stacked mode has top border", () => {
    const html = String(<SettingsRow label="Label" />);
    expect(html).toContain(`border-top:1px solid ${tokens.color.edge}`);
  });

  test("stacked mode renders sub text when provided", () => {
    const html = String(<SettingsRow label="Budget" sub="max daily spend" />);
    expect(html).toContain("max daily spend");
    // mono font appears HTML-entity-escaped in SSR output
    expect(html).toContain("JetBrains Mono");
  });

  test("stacked mode renders value alongside right slot", () => {
    const html = String(<SettingsRow label="Model" value="sonnet-4.6" />);
    expect(html).toContain("sonnet-4.6");
  });

  test("stacked mode renders right slot JSX", () => {
    const html = String(
      <SettingsRow label="Feature" right={<button id="ctrl">toggle</button>} />,
    );
    expect(html).toContain("toggle");
    expect(html).toContain('id="ctrl"');
  });

  test("inline mode renders label and value side by side", () => {
    const html = String(<SettingsRow label="version" value="v1.4.2" inline />);
    expect(html).toContain("version");
    expect(html).toContain("v1.4.2");
    expect(html).toContain("space-between");
  });

  test("inline mode does NOT have top border", () => {
    const html = String(<SettingsRow label="version" value="v1.4.2" inline />);
    expect(html).not.toContain("border-top");
  });

  test("inline + mono uses mono font for value", () => {
    const html = String(<SettingsRow label="pid" value="12345" inline mono />);
    // JetBrains Mono appears HTML-entity-escaped in SSR output
    expect(html).toContain("JetBrains Mono");
  });

  test("inline without mono uses body font for value", () => {
    const html = String(<SettingsRow label="theme" value="warm cream" inline />);
    // Geist body font appears HTML-entity-escaped in SSR output
    expect(html).toContain("Geist");
  });

  test("stacked + firstRow suppresses top divider line", () => {
    // List shells wrap a list in a Card; the first row must not draw
    // a hairline against the Card's interior padding.
    const html = String(<SettingsRow label="First" firstRow />);
    expect(html).not.toContain(`border-top:1px solid ${tokens.color.edge}`);
    expect(html).toContain("border-top:none");
  });
});
