/** @jsxImportSource hono/jsx */
/**
 * Ephemeral brain-health strip on the Home dashboard.
 * Split from Home.test.tsx (400-LOC ratchet).
 */
import { test, expect, describe } from "bun:test";
import { Home } from "../../../src/web/screens/Home";
import { HOME_RENDER_FIXTURE as FIXTURE } from "./_home-render-fixture";

function render(): string {
  return String(<Home data={FIXTURE} />);
}

// ── ephemeral brain-health strip ────────────────────────────────────────────

describe("Home — brain health strip", () => {
  test("strip renders the classified reason while unhealthy", () => {
    const html = String(
      <Home
        data={{
          ...FIXTURE,
          brainHealth: { show: true, line: "⚠ brain paused after 2 resource failures — retrying in 40m", detail: "" },
        }}
      />,
    );
    expect(html).toContain("brain-health-strip");
    expect(html).toContain("⚠ brain paused after 2 resource failures — retrying in 40m");
  });

  test("the raw failure excerpt is the tooltip, not the line", () => {
    // It used to BE the line: the strip led with 80 characters of a JSON tail
    // (`type":"error_during_execution","errors":["[ede_diagnostic] …`) where
    // the state belongs.
    const html = String(
      <Home
        data={{
          ...FIXTURE,
          brainHealth: {
            show: true,
            line: "⚠ brain paused after 4 resource failures — retrying in 12m",
            detail: '"errors":["[ede_diagnostic] result_type=user"]',
          },
        }}
      />,
    );
    expect(html).toContain('title="&quot;errors&quot;:[&quot;[ede_diagnostic] result_type=user&quot;]"');
  });

  test("no excerpt means no empty title attribute", () => {
    const html = String(
      <Home data={{ ...FIXTURE, brainHealth: { show: true, line: "⚠ brain stopped", detail: "" } }} />,
    );
    expect(html).toContain("brain-health-strip");
    expect(html).not.toContain('title=""');
  });

  test("strip is ABSENT from the DOM while healthy (ephemeral, not hidden)", () => {
    const html = render();
    expect(html).not.toContain("brain-health-strip");
  });
});
