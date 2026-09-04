/** @jsxImportSource hono/jsx */
/**
 * family-filter.test.tsx — the timeline builder-family filter (Brain select v2 T7).
 */
import { describe, expect, test } from "bun:test";
import type { CriticTelemetry } from "../../../../src/state/critic-event-log";
import { type FilterState, filterHref } from "../../../../src/web/screens/critic/helpers";
import { TimelineFilterRow } from "../../../../src/web/screens/timeline/filter-row";

const BASE: FilterState = {
  project: null,
  status: null,
  kind: null,
  range: "all",
  sort: "newest",
  query: null,
  family: null,
};

describe("filterHref — family param (T7)", () => {
  test("emits family when set", () => {
    expect(filterHref(BASE, { family: "codex" }, "/timeline")).toContain("family=codex");
  });

  test("clearing family (null) drops it", () => {
    const withFam = { ...BASE, family: "codex" };
    expect(filterHref(withFam, { family: null }, "/timeline")).not.toContain("family=");
  });

  test("family is preserved across a different-facet click", () => {
    const withFam = { ...BASE, family: "agy" };
    // flipping the kind must carry family forward
    expect(filterHref(withFam, { kind: "warning" }, "/timeline")).toContain("family=agy");
  });
});

function filterRowHtml(activeFamily: string | null): string {
  const telemetry = {
    recent: [],
    projects: [],
    activeProject: null,
    activeStatus: null,
    activeKind: null,
    activeFamily,
    activeRange: "all",
    activeSort: "newest",
    activeQuery: null,
    homeBasename: "user",
  } as unknown as CriticTelemetry;
  return String(<TimelineFilterRow telemetry={telemetry} />);
}

describe("TimelineFilterRow — family segment (T7)", () => {
  test("renders an 'all families' option plus a link per family", () => {
    const html = filterRowHtml(null);
    expect(html).toContain("all families");
    for (const f of ["claude", "codex", "agy", "qoder", "codebuddy"]) {
      expect(html).toContain(`family=${f}`);
    }
  });

  test("when a family is active, the 'all families' clear link is offered (family cleared)", () => {
    const html = filterRowHtml("codex");
    // the segment renders regardless of which is active; the clear link goes to
    // /timeline WITHOUT a family param (all families).
    expect(html).toContain("codex");
    expect(html).toContain("all families");
  });
});
