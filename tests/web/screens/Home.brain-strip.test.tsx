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
          brainHealth: { show: true, line: "⚠ brain: resource ×2 — EAGAIN" },
        }}
      />,
    );
    expect(html).toContain("brain-health-strip");
    expect(html).toContain("⚠ brain: resource ×2 — EAGAIN");
  });

  test("strip is ABSENT from the DOM while healthy (ephemeral, not hidden)", () => {
    const html = render();
    expect(html).not.toContain("brain-health-strip");
  });
});
