import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimMarker,
  completeMarker,
  deriveStopMarkerKey,
  hashTranscript,
  markerKey,
  readMarker,
} from "../../src/daemon/marker";

describe("marker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marker-"));
  });

  test("markerKey is deterministic per (session_id, content_hash)", () => {
    const k1 = markerKey({ session_id: "abc", content_hash: "deadbeef" });
    const k2 = markerKey({ session_id: "abc", content_hash: "deadbeef" });
    const k3 = markerKey({ session_id: "abc", content_hash: "feedface" });
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

  test("hashTranscript is stable for identical bytes, differs for different bytes", () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, "same content\n");
    writeFileSync(b, "same content\n");
    expect(hashTranscript(a)).toBe(hashTranscript(b));
    writeFileSync(b, "DIFFERENT content\n");
    expect(hashTranscript(a)).not.toBe(hashTranscript(b));
  });

  test("hashTranscript returns null when the file is missing/unreadable", () => {
    expect(hashTranscript(join(dir, "does-not-exist.jsonl"))).toBeNull();
  });

  test("deriveStopMarkerKey: same session + same transcript → same key (cross-process collision)", () => {
    const t = join(dir, "t.jsonl");
    writeFileSync(t, "turn one\n");
    const k1 = deriveStopMarkerKey({ session_id: "s1", transcript_path: t });
    const k2 = deriveStopMarkerKey({ session_id: "s1", transcript_path: t });
    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
  });

  test("deriveStopMarkerKey: different transcript content → different key (real distinct turns still reviewed)", () => {
    const t1 = join(dir, "t1.jsonl");
    const t2 = join(dir, "t2.jsonl");
    writeFileSync(t1, "turn one\n");
    writeFileSync(t2, "turn two\n");
    expect(deriveStopMarkerKey({ session_id: "s1", transcript_path: t1 })).not.toBe(
      deriveStopMarkerKey({ session_id: "s1", transcript_path: t2 }),
    );
  });

  test("deriveStopMarkerKey: missing transcript_path → null (caller fails soft to review)", () => {
    expect(deriveStopMarkerKey({ session_id: "s1" })).toBeNull();
    expect(
      deriveStopMarkerKey({ session_id: "s1", transcript_path: join(dir, "nope.jsonl") }),
    ).toBeNull();
  });
});
