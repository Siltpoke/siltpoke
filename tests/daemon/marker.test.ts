import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimMarker,
  completeMarker,
  readMarker,
  markerKey,
} from "../../src/daemon/marker";

describe("marker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marker-"));
  });

  test("markerKey is deterministic per (session_id, timestamp)", () => {
    const k1 = markerKey({ session_id: "abc", stop_event_timestamp_ms: 1234 });
    const k2 = markerKey({ session_id: "abc", stop_event_timestamp_ms: 1234 });
    const k3 = markerKey({ session_id: "abc", stop_event_timestamp_ms: 1235 });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  test("claimMarker is atomic — second claim returns false", () => {
    const key = "abc";
    expect(claimMarker(dir, key)).toBe(true);
    expect(claimMarker(dir, key)).toBe(false);
  });

  test("readMarker returns claimed state after claim", () => {
    const key = "abc";
    claimMarker(dir, key);
    expect(readMarker(dir, key)?.state).toBe("claimed");
  });

  test("completeMarker flips state to done", () => {
    const key = "abc";
    claimMarker(dir, key);
    completeMarker(dir, key);
    expect(readMarker(dir, key)?.state).toBe("done");
  });

  test("stale claimed (>120s) is flagged staleClaim=true", () => {
    const key = "abc";
    claimMarker(dir, key);
    const m = readMarker(dir, key)!;
    const stale = { ...m, claimedAt: Date.now() - 200_000 };
    writeFileSync(join(dir, `${key}.marker`), JSON.stringify(stale));
    expect(readMarker(dir, key)?.staleClaim).toBe(true);
  });

  test("readMarker returns null for missing key", () => {
    expect(readMarker(dir, "nope")).toBeNull();
  });
});
