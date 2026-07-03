/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Wizard } from "../../../src/web/shells/Wizard";
import { tokens } from "../../../src/web/tokens/tokens";

describe("Wizard", () => {
  test("renders step counter text", () => {
    const html = String(
      <Wizard step={2} totalSteps={4} nextHref="/step/3" prevHref="/step/1">
        content
      </Wizard>,
    );
    expect(html).toContain("Step 2 of 4");
  });

  test("renders phone frame — ink background shell", () => {
    const html = String(
      <Wizard step={1} totalSteps={3} nextHref="/step/2">
        content
      </Wizard>,
    );
    // PhoneFrame uses tokens.color.ink as the frame background
    expect(html).toContain(tokens.color.ink);
  });

  test("renders notch inside phone frame", () => {
    const html = String(
      <Wizard step={1} totalSteps={3} nextHref="/step/2">
        content
      </Wizard>,
    );
    // Notch is the ink-colored pill at top center
    expect(html).toContain("width:70");
  });

  test("renders time/battery status bar", () => {
    const html = String(
      <Wizard step={1} totalSteps={3} nextHref="/step/2">
        content
      </Wizard>,
    );
    expect(html).toContain("14:32");
    expect(html).toContain("87%");
  });

  test("renders children inside phone frame", () => {
    const html = String(
      <Wizard step={1} totalSteps={2} nextHref="/step/2">
        <span id="step-body">step content</span>
      </Wizard>,
    );
    expect(html).toContain('id="step-body"');
    expect(html).toContain("step content");
  });

  test("prev link rendered with href when not on first step", () => {
    const html = String(
      <Wizard step={2} totalSteps={4} prevHref="/step/1" nextHref="/step/3">
        content
      </Wizard>,
    );
    expect(html).toContain('href="/step/1"');
    expect(html).toContain("← prev");
  });

  test("prev disabled (span) on first step", () => {
    const html = String(
      <Wizard step={1} totalSteps={3} nextHref="/step/2">
        content
      </Wizard>,
    );
    // No href for prev when at first step
    expect(html).not.toContain('href="/step/0"');
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("← prev");
  });

  test("next link rendered with href when not on last step", () => {
    const html = String(
      <Wizard step={2} totalSteps={4} prevHref="/step/1" nextHref="/step/3">
        content
      </Wizard>,
    );
    expect(html).toContain('href="/step/3"');
    expect(html).toContain("next →");
  });

  test("active prev/next links carry hx-boost=true (plan-required)", () => {
    // Body has hx-boost via layout; explicit attribute on the <a>
    // documents intent and survives if a host strips boost from body.
    const html = String(
      <Wizard step={2} totalSteps={4} prevHref="/step/1" nextHref="/step/3">
        content
      </Wizard>,
    );
    expect(html).toContain('hx-boost="true"');
  });

  test("disabled prev/next spans carry aria-disabled for screen readers", () => {
    const html = String(
      <Wizard step={1} totalSteps={1}>
        content
      </Wizard>,
    );
    // Both prev (first step) and next (last step) disabled — both spans
    // must announce as disabled.
    const matches = html.match(/aria-disabled="true"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("next disabled (span) on last step", () => {
    const html = String(
      <Wizard step={4} totalSteps={4} prevHref="/step/3">
        content
      </Wizard>,
    );
    // pointer-events:none marks the disabled span
    expect(html).toContain("pointer-events:none");
    expect(html).toContain("next →");
  });

  test("step counter uses mono font", () => {
    const html = String(
      <Wizard step={1} totalSteps={3} nextHref="/step/2">
        content
      </Wizard>,
    );
    expect(html).toContain("JetBrains Mono");
  });

  test("phone frame has 32px border-radius", () => {
    const html = String(
      <Wizard step={1} totalSteps={2} nextHref="/step/2">
        content
      </Wizard>,
    );
    expect(html).toContain("border-radius:32");
  });
});
