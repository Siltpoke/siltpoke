/**
 * chat-error-copy — the single reason→copy map shared by BOTH chat islands.
 *
 * Covers:
 *  - totality: every classified reason maps to distinct, fixed pet-voice copy
 *  - fallback: unknown / absent / prototype-key reasons all yield the fallback
 *  - retirement: the old raw fallback string is gone from src/ scripts/ tests/
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_ERROR_COPY,
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
  chatErrorCopy,
  makeFailedEntry,
  parseErrorEvent,
} from "../../../../src/web/client/lib/chat-error-copy";

describe("chatErrorCopy — reason→copy map", () => {
  test("each classified reason maps to its fixed copy", () => {
    expect(chatErrorCopy("timeout")).toBe(
      "I waited a whole minute but my brain never answered. (backend timeout — try sending that again?)",
    );
    expect(chatErrorCopy("spawn_failed")).toBe(
      "I couldn't reach my brain at all just now. (couldn't start claude — is it installed and logged in?)",
    );
    expect(chatErrorCopy("empty_exit")).toBe(
      "My brain came back with… nothing. (empty response — try once more?)",
    );
  });

  test("the three reason copies are pairwise distinct", () => {
    const values = Object.values(CHAT_ERROR_COPY);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(3);
  });

  test("unknown / absent reason falls back (route-catch rows carry no reason)", () => {
    expect(chatErrorCopy(undefined)).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(chatErrorCopy(null)).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(chatErrorCopy("")).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(chatErrorCopy("some_future_reason")).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(CHAT_ERROR_FALLBACK_COPY).toBe(
      "Something broke on my side. (unknown error — try again?)",
    );
  });

  test("prototype-chain keys do not leak object internals as copy", () => {
    expect(chatErrorCopy("toString")).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(chatErrorCopy("constructor")).toBe(CHAT_ERROR_FALLBACK_COPY);
  });

  test("fallback copy is distinct from every classified copy", () => {
    for (const copy of Object.values(CHAT_ERROR_COPY)) {
      expect(copy).not.toBe(CHAT_ERROR_FALLBACK_COPY);
    }
  });

  test("stopped marker is quiet, short, and not an error copy", () => {
    expect(CHAT_STOPPED_MARKER).toBe("stopped");
    expect(Object.values(CHAT_ERROR_COPY)).not.toContain(CHAT_STOPPED_MARKER);
  });
});

describe("parseErrorEvent — SSE error-frame parse, safe on garbage", () => {
  test("classified frame → { reason }", () => {
    expect(parseErrorEvent('{"error":"raw detail","reason":"timeout"}')).toEqual({
      reason: "timeout",
    });
  });

  test("reason-less frame (route-catch shape) → {}", () => {
    expect(parseErrorEvent('{"error":"unclassified"}')).toEqual({});
  });

  test("garbage inputs all yield {} (never throw, never leak)", () => {
    expect(parseErrorEvent("not json at all")).toEqual({});
    expect(parseErrorEvent("")).toEqual({});
    expect(parseErrorEvent("null")).toEqual({});
    expect(parseErrorEvent('"just a string"')).toEqual({});
    expect(parseErrorEvent("[1,2,3]")).toEqual({});
    expect(parseErrorEvent('{"reason":42}')).toEqual({}); // non-string reason
    expect(parseErrorEvent('{"reason":null}')).toEqual({});
  });

  test("the raw server error string is never extracted", () => {
    const out = parseErrorEvent('{"error":"ENOENT /secret/path","reason":"spawn_failed"}');
    expect(JSON.stringify(out)).not.toContain("ENOENT");
  });
});

describe("makeFailedEntry — failed-turn transcript entry builder", () => {
  test("classified reason → reason copy + error_reason", () => {
    expect(makeFailedEntry("timeout")).toEqual({
      role: "assistant",
      text: CHAT_ERROR_COPY.timeout,
      status: "failed",
      error_reason: "timeout",
    });
  });

  test("no reason → fallback copy and NO error_reason key (none invented)", () => {
    const entry = makeFailedEntry();
    expect(entry).toEqual({
      role: "assistant",
      text: CHAT_ERROR_FALLBACK_COPY,
      status: "failed",
    });
    expect("error_reason" in entry).toBe(false);
  });

  test("unknown reason → fallback copy but the carried reason is preserved", () => {
    expect(makeFailedEntry("some_future_reason")).toEqual({
      role: "assistant",
      text: CHAT_ERROR_FALLBACK_COPY,
      status: "failed",
      error_reason: "some_future_reason",
    });
  });
});

describe("old empty-stream fallback string retirement", () => {
  // Built from parts so this file never contains the literal itself.
  const needle = ["No reply received ", "(backend returned empty stream)"].join("");
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

  function fileContainsNeedle(path: string): boolean {
    try {
      return readFileSync(path, "utf8").includes(needle);
    } catch {
      return false; // unreadable/binary — not a code carrier of the string
    }
  }

  function scan(dir: string, offenders: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        scan(full, offenders);
      } else if (st.isFile() && fileContainsNeedle(full)) {
        offenders.push(full);
      }
    }
  }

  test("the retired string appears nowhere under src/, scripts/, tests/", () => {
    const offenders: string[] = [];
    for (const root of ["src", "scripts", "tests"]) {
      scan(join(repoRoot, root), offenders);
    }
    expect(offenders).toEqual([]);
  });
});
