import { describe, expect, test } from "bun:test";
import { stalenessVerdict } from "../../src/repo-graph/staleness-verdict";
import type { IndexStaleness } from "../../src/repo-graph/index-health";

const base: IndexStaleness = {
  indexed: 10, unchanged: 10, content_changed: 0, deleted_still_indexed: 0,
  unindexed_files: 0, read_errors: 0, content_stale_pct: 0, rows_wrong_pct: 0,
};
const s = (o: Partial<IndexStaleness>): IndexStaleness => ({ ...base, ...o });

describe("stalenessVerdict", () => {
  test("null → not_indexed", () => {
    expect(stalenessVerdict(null, 0.2).level).toBe("not_indexed");
  });
  test("indexed===0 → not_indexed, even with read_errors (precedence)", () => {
    expect(stalenessVerdict(s({ indexed: 0, read_errors: 3 }), 0.2).level).toBe("not_indexed");
  });
  test("all clean → fresh, no counts shown by caller (level fresh)", () => {
    expect(stalenessVerdict(s({}), 0.2).level).toBe("fresh");
  });
  test("1/5 changed = 20% → stale (inclusive boundary)", () => {
    expect(stalenessVerdict(s({ indexed: 5, unchanged: 4, content_changed: 1, rows_wrong_pct: 0.2 }), 0.2).level).toBe("stale");
  });
  test("1/6 changed = 16.7% → drifting", () => {
    expect(stalenessVerdict(s({ indexed: 6, unchanged: 5, content_changed: 1, rows_wrong_pct: 1 / 6 }), 0.2).level).toBe("drifting");
  });
  test("unindexed-only reaches stale via combined ratio (2 idx + 8 unindexed = 0.8)", () => {
    expect(stalenessVerdict(s({ indexed: 2, unchanged: 2, unindexed_files: 8 }), 0.2).level).toBe("stale");
  });
  test("compound 15%+15% (each below gate) → stale via combined ratio", () => {
    // indexed 100 (15 wrong), 18 unindexed → (15+18)/(118)=0.28 ≥ 0.2
    const v = stalenessVerdict(s({ indexed: 100, unchanged: 85, content_changed: 15, unindexed_files: 18, rows_wrong_pct: 0.15 }), 0.2);
    expect(v.level).toBe("stale");
  });
  test("read_errors>0 with provably-stale files → stale (NOT unknown), caveat set", () => {
    const v = stalenessVerdict(s({ indexed: 10, unchanged: 4, content_changed: 6, read_errors: 1, rows_wrong_pct: 0.6 }), 0.2);
    expect(v.level).toBe("stale");
    expect(v.caveat).toContain("1");
  });
  test("read_errors>0 and NOT provably stale → unknown", () => {
    const v = stalenessVerdict(s({ indexed: 10, unchanged: 10, read_errors: 2 }), 0.2);
    expect(v.level).toBe("unknown");
    expect(v.caveat).toContain("2");
  });
  test("some drift below gate → drifting, no caveat", () => {
    expect(stalenessVerdict(s({ indexed: 10, unchanged: 9, content_changed: 1, rows_wrong_pct: 0.1 }), 0.2).level).toBe("drifting");
  });
});
