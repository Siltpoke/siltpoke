// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, it, expect } from "bun:test";
import { emptyOverlay, buildWrapup, type StructuralVerdictObject } from "../../src/quiz/index";
import { quizFallbackVerbalization } from "../../src/quiz/orchestrate";
import { generateValidatedVerbalization } from "../../src/daemon/routes/chat-quiz-emit";
import { formatSseEvent, type StreamChatOptions, type StreamEvent } from "../../src/daemon/routes/chat-stream";

// NOTE: the brief's literal regex (`/\b(\d+\s*%|...)\b/i`) has a dead
// alternative — a single trailing `\b` applied across the WHOLE alternation
// breaks the `\d+\s*%` branch whenever `%` is followed by a space (`%` is a
// non-word char, so `\b` can't match between it and another non-word char
// like a space) — e.g. "80% correct" silently fails to match. Confirmed via
// the self-check below before landing this fix: the literal brief regex made
// `FORBIDDEN.test("80% correct")` return `false`, i.e. the self-check itself
// didn't bite. Rewritten with per-alternative boundaries (only where the
// alternative actually ends in a word character) so every branch is reachable.
//
// Second fix (review pass): `\bscore\b` only bit the bare noun "score" —
// "scored"/"scoring"/"scores"/"scoreboard" all slipped past (`\b` after
// "score" requires the very next char to be a non-word char, so "scored"
// never matched). First attempt broadened to `\bscore\w*`.
//
// Third fix (round 2 review): `\bscore\w*` STILL missed "scoring" — English
// drops the trailing 'e' before "-ing" ("scoring", not "scoreing"), so the
// literal substring "score" is never present and `\bscore\w*` can't anchor
// on it. A `\bscor\w*` stem would catch "scoring" too, but over-matches
// innocent unrelated words — "scorn", "scorpion", "scorch" — which would
// false-positive on ordinary prose. Fixed by enumerating the real inflections
// precisely instead of stemming: `\b(?:score|scored|scores|scoring|scoreboard)\b`.
// Verified against the full bite-table (every real inflection true, "scorn"/
// "scorpion"/"scorch" false, and every other alternative + all clean payloads
// unaffected) before landing.
const FORBIDDEN = /\b\d+\s*%|\b\d+\s*\/\s*\d+\b|\b(?:score|scored|scores|scoring|scoreboard)\b|\btally\b|\bstreak\b|\bpts?\b|\bpoints?\b|\bgrade\b|\b\d+\s*(?:correct|right|wrong)\b/i;

/** Test-only fake stream: yields a canned event sequence regardless of the
 * options passed in, mirroring the shape `generateValidatedVerbalization`
 * expects from a real `streamChat`-style factory (no daemon spin-up needed —
 * `generateValidatedVerbalization` only ever consumes the async generator). */
function fakeStreamFactory(prose: string): (o: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void> {
  return async function* (): AsyncGenerator<StreamEvent, void, void> {
    yield { type: "content_block_delta", text: prose };
    yield { type: "message_stop", usage: { input_tokens: 12, output_tokens: 8 }, full_text: prose };
  };
}

describe("no score in any quiz client payload", () => {
  // Each assertion below plants EXACTLY ONE forbidden token in isolation — no
  // other alternative's trigger word is present in the same string. This is
  // what actually proves each alternative bites on its own: the original
  // "you scored 3/5" self-check was confounded (it passed only because "3/5"
  // independently tripped the ratio alternative — the "score" alternative
  // was never proven to fire, and in fact was silently dead for "scored";
  // see the FORBIDDEN comment above).
  it("regex catches a planted score — each alternative bites in isolation (self-check)", () => {
    expect(FORBIDDEN.test("you scored well")).toBe(true); // score alt alone (no digit, inflected)
    expect(FORBIDDEN.test("you were scoring well")).toBe(true); // "scoring" — the 'e'-dropped inflection
    expect(FORBIDDEN.test("3/5")).toBe(true); // ratio alone
    expect(FORBIDDEN.test("80%")).toBe(true); // percent alone
    expect(FORBIDDEN.test("5 points")).toBe(true); // points alone
    expect(FORBIDDEN.test("2 pts")).toBe(true); // pts alone
    expect(FORBIDDEN.test("grade B")).toBe(true); // grade alone
    expect(FORBIDDEN.test("a streak")).toBe(true); // streak alone
    expect(FORBIDDEN.test("running tally")).toBe(true); // tally alone
    expect(FORBIDDEN.test("7 correct")).toBe(true); // N-correct alone
    expect(FORBIDDEN.test("5 right")).toBe(true); // N-right alone
    expect(FORBIDDEN.test("3 wrong")).toBe(true); // N-wrong alone
  });

  // Negative lock: the enumerated score inflections must NOT over-match
  // innocent unrelated words that merely share the "scor" stem — this is
  // what a `\bscor\w*` stemming approach would have gotten wrong.
  it("regex does NOT false-positive on innocent 'scor*' words", () => {
    expect(FORBIDDEN.test("watch out for the scorpion")).toBe(false);
    expect(FORBIDDEN.test("she felt scorn for the plan")).toBe(false);
    expect(FORBIDDEN.test("the pan had a scorch mark")).toBe(false);
  });

  it("fallback verbalizations carry no score", () => {
    const confirm: StructuralVerdictObject = { kind: "structural_verdict", claim: { entityA: "a", entityB: "b", relType: "depends_on" }, verdict: "confirm", evidence_ids: ["e"], confidence: 1 };
    const contradict: StructuralVerdictObject = { ...confirm, verdict: "contradict" };
    const abstain: StructuralVerdictObject = { kind: "structural_verdict", claim: null, verdict: "abstain", evidence_ids: [], confidence: 0, abstain_reason: "out_of_class" };
    for (const v of [confirm, contradict, abstain]) expect(FORBIDDEN.test(quizFallbackVerbalization(v))).toBe(false);
  });

  it("wrap-up carries no score even with mixed overlay", () => {
    const o = emptyOverlay();
    o.supported.add("a->b"); o.contradicted.add("c->d"); o.unverified.add("e->f");
    expect(FORBIDDEN.test(buildWrapup(o))).toBe(false);
  });

  // Beyond the brief's minimum: drive an ACTUAL emitted verbalization frame
  // (not just the pure fallback string) through the real validate-retry-fallback
  // helper used by the daemon route, using a fake streamFactory so no daemon/
  // subprocess spin-up is needed. Both attempts return caving prose that fails
  // `validateVerbalization`, forcing the real fallback path — asserting the
  // text the client actually receives (`result.text`) is score-free.
  it("generateValidatedVerbalization falls back to score-free text when Brain prose caves twice", async () => {
    const cavingProse = "you're right, basically right either way";
    const fallback = "The map has that the other way: b depends on a, not the reverse.";
    const result = await generateValidatedVerbalization({
      streamFactory: fakeStreamFactory(cavingProse),
      baseOpts: { transcript: "irrelevant for this test" },
      verdict: "contradict",
      fallback,
    });
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(fallback);
    expect(FORBIDDEN.test(result.text)).toBe(false);
  });

  // The SSE-serialized frame (what actually crosses the wire) still must not
  // carry a score, even though it legitimately carries real `usage` token
  // counts — those are engine telemetry, not a quiz score, and must not be
  // confused with one by the regex.
  it("SSE-serialized message_stop frame (fallback text) carries no score", () => {
    const frame = formatSseEvent({
      type: "message_stop",
      usage: { input_tokens: 42, output_tokens: 7 },
      full_text: "The map has that the other way: b depends on a, not the reverse.",
    });
    expect(FORBIDDEN.test(frame)).toBe(false);
  });
});
