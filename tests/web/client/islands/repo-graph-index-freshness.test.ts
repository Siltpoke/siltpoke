/** Code Map must not say "Diagram is current" over an index that is out of date.
 *
 * 2026-10-15, agent-runtime: the index was built at 17:54, `helpers/` was added
 * at 18:05, the diagram was re-generated at 20:44 from the 17:54 index, and the
 * button read "Diagram is current" — while GET /api/repo-graph/staleness said
 * "88% out of date". "Current" compared the diagram with the index only, never
 * the index with the code.
 */
import { describe, expect, it } from "bun:test";
import type { StalenessVerdict } from "../../../../src/repo-graph/staleness-verdict";
import { archAffordanceState } from "../../../../src/web/client/islands/repo-graph";
import { freshnessOf, indexStaleLine } from "../../../../src/web/client/islands/repo-graph-index-freshness";

function verdict(level: StalenessVerdict["level"], counts: Partial<StalenessVerdict["counts"]> = {}): StalenessVerdict {
  return {
    level,
    headline: "",
    caveat: null,
    counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 5, wrong_ratio: 0, ...counts },
  };
}

describe("freshnessOf", () => {
  it("maps verdict levels to what the page may claim", () => {
    expect(freshnessOf(verdict("fresh"))).toBe("fresh");
    expect(freshnessOf(verdict("drifting"))).toBe("behind");
    expect(freshnessOf(verdict("stale"))).toBe("behind");
    expect(freshnessOf(verdict("unknown"))).toBe("unknown");
    expect(freshnessOf(verdict("not_indexed"))).toBe("unknown");
  });

  it("a failed check is unknown, never fresh", () => {
    expect(freshnessOf(null)).toBe("unknown");
  });
});

describe("indexStaleLine", () => {
  it("agent-runtime's 2026-10-15 numbers: 4 edited, 3 new", () => {
    expect(indexStaleLine(verdict("stale", { content_changed: 4, unindexed_files: 3 }))).toBe(
      "· code changed since this map was indexed: 4 files edited, 3 new — re-index",
    );
  });

  it("singular and deleted files", () => {
    expect(indexStaleLine(verdict("drifting", { content_changed: 1, deleted_still_indexed: 2 }))).toBe(
      "· code changed since this map was indexed: 1 file edited, 2 deleted — re-index",
    );
  });

  it("says nothing for a fresh index, an unknown one, or a failed check", () => {
    expect(indexStaleLine(verdict("fresh"))).toBeNull();
    expect(indexStaleLine(verdict("unknown"))).toBeNull();
    expect(indexStaleLine(null)).toBeNull();
  });
});

describe("archAffordanceState with index freshness", () => {
  it("cached + diagram matches index + index fresh → 'Diagram is current' (unchanged)", () => {
    expect(archAffordanceState("generated", true, false, "fresh").hint).toBe("Diagram is current");
  });

  it("index behind → the button re-indexes first, whatever the diagram cache says", () => {
    for (const [hasGenerated, stale] of [[true, false], [true, true], [false, false]] as const) {
      const d = archAffordanceState("generated", hasGenerated, stale, "behind");
      expect(d.clickMode).toBe("reindex");
      expect(d.label).toBe("↻ Re-index — code changed");
      expect(d.hint).toBeNull();
      expect(d.tier).toBe("accent");
    }
  });

  it("never claims 'Diagram is current' when the index check failed or has not answered yet", () => {
    expect(archAffordanceState("generated", true, false, "unknown").hint).toBe("index freshness unknown");
    expect(archAffordanceState("generated", true, false, "pending").hint).toBeNull();
  });

  it("omitting the index argument keeps the old behaviour (existing callers)", () => {
    expect(archAffordanceState("generated", true, false).hint).toBe("Diagram is current");
  });
});
