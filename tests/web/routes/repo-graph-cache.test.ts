import { describe, expect, test } from "bun:test";
import { createPageCache } from "../../../src/web/routes/repo-graph-cache";

describe("repo-graph page cache", () => {
  test("returns cached html for the same project + index version within the TTL", () => {
    const c = createPageCache(5000);
    c.set("proj-a", "ts-1", "<html>A</html>", 1000);
    expect(c.get("proj-a", "ts-1", 1000)).toBe("<html>A</html>");
    expect(c.get("proj-a", "ts-1", 5999)).toBe("<html>A</html>"); // just under TTL
  });

  test("invalidates instantly when the index version (last_indexed_ts) changes — a re-index", () => {
    const c = createPageCache(5000);
    c.set("proj-a", "ts-1", "<html>old</html>", 1000);
    expect(c.get("proj-a", "ts-2", 1000)).toBeNull(); // re-indexed → miss, never serve stale graph
  });

  test("expires after the TTL (bounds staleness-banner / CLAUDE.md freshness)", () => {
    const c = createPageCache(5000);
    c.set("proj-a", "ts-1", "<html>A</html>", 1000);
    expect(c.get("proj-a", "ts-1", 6000)).toBeNull(); // 1000 + 5000 = 6000, not < expiresAt
    expect(c.get("proj-a", "ts-1", 6001)).toBeNull();
  });

  test("miss for an unknown project", () => {
    const c = createPageCache(5000);
    expect(c.get("nope", "ts-1", 1000)).toBeNull();
  });

  test("one entry per project — a newer render replaces the older", () => {
    const c = createPageCache(5000);
    c.set("proj-a", "ts-1", "<html>v1</html>", 1000);
    c.set("proj-a", "ts-2", "<html>v2</html>", 2000);
    expect(c.get("proj-a", "ts-1", 2000)).toBeNull(); // old index version gone
    expect(c.get("proj-a", "ts-2", 2000)).toBe("<html>v2</html>");
  });
});
