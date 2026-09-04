/** @jsxImportSource hono/jsx */
/**
 * AC9 — the truncation count has to reach a surface a human looks at.
 *
 * A count that nothing renders is the failure mode this whole design was warned
 * about (an internal design note): SARIF's
 * `result.kind` ignored by GitHub Code Scanning, nyc's `--all` broken for three
 * years, a GitHub Actions reporter showing correctly-tagged skipped tests as
 * passed. In every one of those the schema was right and the renderer collapsed
 * it anyway.
 *
 * `truncated` has to cross three hand-written layers to get here — the schema,
 * `critic-event-log-types.ts`, and `critic-event-log-parse.ts` — none of which
 * propagate a new field automatically. These tests are what stop any one of them
 * from silently dropping it.
 */
import { test, expect, describe } from "bun:test";
import { DiffSummaryView } from "../../../../src/web/screens/critic/diff/render";
import type { CriticCall } from "../../../../src/state/api";

type Summary = NonNullable<CriticCall["diff_summary"]>;

function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    intent: "some change",
    key_changes: ["one", "two"],
    risks: ["a risk"],
    file_count: 1,
    files_with_purpose: [{ path: "src/foo.ts", purpose: "p" }],
    source: "haiku",
    ...overrides,
  };
}

describe("DiffSummaryView — truncation note (AC9)", () => {
  test("dropped risks are announced with their count", () => {
    const html = String(
      <DiffSummaryView summary={makeSummary({ truncated: { risks: 3 } })} />,
    );
    expect(html).toContain("3");
    expect(html).toContain("risks");
    expect(html).toContain("dropped to fit");
  });

  test("dropped key_changes are announced separately from risks", () => {
    const html = String(
      <DiffSummaryView summary={makeSummary({ truncated: { key_changes: 2 } })} />,
    );
    expect(html).toContain("2 more changes");
  });

  test("both counts render when both arrays were truncated", () => {
    const html = String(
      <DiffSummaryView
        summary={makeSummary({ truncated: { key_changes: 2, risks: 3 } })}
      />,
    );
    expect(html).toContain("2 more changes");
    expect(html).toContain("3 more risks");
  });

  // Positive control. Without it, the tests above could pass for a component that
  // renders the note unconditionally, which would tell the user something was
  // dropped on every single clean review.
  test("no truncation -> the note does not appear at all", () => {
    const html = String(<DiffSummaryView summary={makeSummary()} />);
    expect(html).not.toContain("dropped to fit");
  });

  // Records written before the field existed have no `truncated` key at all.
  test("a summary with no truncated field renders without the note and without crashing", () => {
    const legacy = makeSummary();
    delete (legacy as Partial<Summary>).truncated;
    const html = String(<DiffSummaryView summary={legacy} />);
    expect(html).toContain("some change");
    expect(html).not.toContain("dropped to fit");
  });

  // A zero must read as "nothing dropped", not as a note saying "0 more".
  test("an explicit zero is not announced", () => {
    const html = String(
      <DiffSummaryView summary={makeSummary({ truncated: { risks: 0 } })} />,
    );
    expect(html).not.toContain("dropped to fit");
  });
});
