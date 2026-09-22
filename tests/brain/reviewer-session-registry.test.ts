// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The registry half both reapers now share. Its two safety gates — the
 * anchored UUID test and the containment predicate — are the reason a reaper
 * may delete files at all, so they are asserted here directly rather than only
 * through each host's reaper.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionId,
  dropReapedFromRegistry,
  isWithin,
  readRegistry,
  type ReviewerSessionRecord,
  selectReapable,
  STRICT_UUID_RE,
} from "../../src/brain/reviewer-session-registry";

const UUID = "1234abcd-1234-1234-1234-123456789012";

function rec(id: string, recordedAt: number): ReviewerSessionRecord {
  return { id, recordedAt };
}

describe("STRICT_UUID_RE", () => {
  test("accepts a canonical uuid", () => {
    expect(STRICT_UUID_RE.test(UUID)).toBe(true);
  });

  test("rejects a traversal that merely CONTAINS one", () => {
    // The whole reason the pattern is anchored: an unanchored test passes this
    // string, and the id then becomes part of a path.
    expect(STRICT_UUID_RE.test(`../../etc/${UUID}`)).toBe(false);
    expect(STRICT_UUID_RE.test(`${UUID}/../..`)).toBe(false);
    expect(STRICT_UUID_RE.test("")).toBe(false);
    expect(STRICT_UUID_RE.test(".")).toBe(false);
  });
});

describe("isWithin", () => {
  test("the root itself and its children are inside", () => {
    expect(isWithin("/tmp/root", "/tmp/root")).toBe(true);
    expect(isWithin("/tmp/root", "/tmp/root/a.db")).toBe(true);
    expect(isWithin("/tmp/root", "/tmp/root/deep/a.db")).toBe(true);
  });

  test("a sibling whose name merely starts with the root is outside", () => {
    // /tmp/rootless would pass a bare startsWith without the separator.
    expect(isWithin("/tmp/root", "/tmp/rootless/a.db")).toBe(false);
  });

  test("a traversal that climbs back out is outside", () => {
    expect(isWithin("/tmp/root", "/tmp/root/../other/a.db")).toBe(false);
  });
});

describe("selectReapable", () => {
  const old = 1_000;
  const now = 1_000_000_000;
  const fresh = now - 1_000;

  test("nothing is reapable while the registry is within keepLast", () => {
    const registry = [rec("a", old), rec("b", old)];
    expect(selectReapable(registry, { keepLast: 2, olderThanMs: 10, now })).toEqual([]);
  });

  test("beyond keepLast, only entries past the min age are reapable", () => {
    const registry = [rec("old", old), rec("young", fresh), rec("newest", now)];
    const out = selectReapable(registry, { keepLast: 1, olderThanMs: 10_000, now });
    expect(out.map((r) => r.id)).toEqual(["old"]);
  });

  test("the keepLast newest are chosen by recordedAt, not by array order", () => {
    // Written newest-first on purpose: a slice that trusted insertion order
    // would keep the wrong ones and reap the newest.
    const registry = [rec("newest", now), rec("mid", old + 2), rec("oldest", old)];
    const out = selectReapable(registry, { keepLast: 1, olderThanMs: 10, now });
    expect(out.map((r) => r.id).sort()).toEqual(["mid", "oldest"]);
  });

  test("exactly one past keepLast reaps exactly that one", () => {
    // The boundary the other cases step over: `<= keepLast` returns nothing and
    // a registry far past keepLast hides slice arithmetic that is off by one
    // only here. Raised in review as the gap the 8 mutations covered indirectly.
    const registry = [rec("oldest", old), rec("keep1", now - 2), rec("keep2", now - 1)];
    const out = selectReapable(registry, { keepLast: 2, olderThanMs: 10_000, now });
    expect(out.map((r) => r.id)).toEqual(["oldest"]);
  });

  test("a fresh entry is never reaped, however far past keepLast it sits", () => {
    const registry = [rec("young1", fresh), rec("young2", fresh), rec("newest", now)];
    expect(selectReapable(registry, { keepLast: 1, olderThanMs: 10_000, now })).toEqual([]);
  });
});

describe("the registry file", () => {
  function tmpRegistry(body?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "reaper-registry-"));
    const path = join(dir, "registry.json");
    if (body !== undefined) writeFileSync(path, body);
    return path;
  }

  test("malformed rows are dropped rather than trusted — they become paths", () => {
    const path = tmpRegistry(
      JSON.stringify([
        { id: UUID, recordedAt: 1 },
        { id: 5, recordedAt: 1 },
        { id: UUID },
        null,
        "nope",
      ]),
    );
    try {
      expect(readRegistry(path)).toEqual([{ id: UUID, recordedAt: 1 }]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("a missing or unparseable file reads as empty, not as an error", () => {
    expect(readRegistry(join(tmpdir(), "does-not-exist-12345.json"))).toEqual([]);
    const path = tmpRegistry("{not json");
    try {
      expect(readRegistry(path)).toEqual([]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("appendSessionId adds an entry, and skips an immediate repeat", () => {
    const path = tmpRegistry("[]");
    try {
      appendSessionId(path, "a", 10);
      appendSessionId(path, "a", 20);
      expect(readRegistry(path)).toEqual([{ id: "a", recordedAt: 10 }]);
      appendSessionId(path, "b", 30);
      appendSessionId(path, "a", 40);
      expect(readRegistry(path).map((r) => r.id)).toEqual(["a", "b", "a"]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("dropReapedFromRegistry leaves the file untouched when nothing was reaped", () => {
    const original = JSON.stringify([{ id: "a", recordedAt: 1 }]);
    const path = tmpRegistry(original);
    try {
      dropReapedFromRegistry(path, [rec("a", 1)], []);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("dropReapedFromRegistry keeps the survivors in their original order", () => {
    const path = tmpRegistry("[]");
    try {
      const registry = [rec("a", 1), rec("b", 2), rec("c", 3)];
      dropReapedFromRegistry(path, registry, [rec("b", 2)]);
      expect(readRegistry(path).map((r) => r.id)).toEqual(["a", "c"]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
