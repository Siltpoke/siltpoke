/**
 * The waiting line under the typing dots: `waitLabel()`.
 *
 * The stage label and the elapsed seconds are gated SEPARATELY, and these
 * tests exist to keep them that way. An earlier revision gated them together
 * as `elapsedSec >= 3 || phaseLabel()` while its comment claimed the seconds
 * were held until 3s — and because `waking` arrives roughly a second into
 * every real turn, the counter in fact appeared at ~1s on every real turn.
 * The hold only ever applied to a stream that emitted no phase at all.
 *
 * So the load-bearing case here is the FIRST one: a phase is set, the wait is
 * short, and the seconds must still be absent. Re-merging the two gates turns
 * that assertion red; asserting only the >= 3s cases would not.
 */
import { test, expect, describe } from "bun:test";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";

/** The factory needs a fetch + deps; none of them are exercised by waitLabel(). */
function island() {
  const fetchFn = (async () => new Response("")) as unknown as typeof fetch;
  return makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
}

describe("waitLabel — stage label and seconds are gated separately", () => {
  test("phase set, under 3s → label only, and NO seconds", () => {
    const d = island();
    d.phase = "waking";
    d.elapsedSec = 1;

    expect(d.waitLabel()).toBe("waking up");
    // The whole point: the number is withheld even though a phase is showing.
    expect(d.waitLabel()).not.toContain("s");
    expect(d.waitLabel()).not.toContain("1");
  });

  test("phase set at exactly 2s → still no seconds (boundary below the hold)", () => {
    const d = island();
    d.phase = "ready";
    d.elapsedSec = 2;
    expect(d.waitLabel()).toBe("asking siltpoke");
  });

  test("phase set at exactly 3s → seconds appear, joined to the label", () => {
    const d = island();
    d.phase = "ready";
    d.elapsedSec = 3;
    expect(d.waitLabel()).toBe("asking siltpoke · 3s");
  });

  test("no phase yet, under 3s → renders nothing at all", () => {
    const d = island();
    d.phase = null;
    d.elapsedSec = 2;
    // "" is also the row's x-show, so this is "the line is not on screen".
    expect(d.waitLabel()).toBe("");
  });

  test("no phase, past 3s → bare seconds (a stream that reports no stage)", () => {
    const d = island();
    d.phase = null;
    d.elapsedSec = 9;
    expect(d.waitLabel()).toBe("9s");
  });

  test("thinking carries the CLI's own token estimate, not an invented label", () => {
    const d = island();
    d.phase = "thinking";
    d.phaseDetail = "350";
    d.elapsedSec = 8;
    expect(d.waitLabel()).toBe("thinking · 350 tokens · 8s");
  });

  test("thinking with no estimate degrades to the bare stage", () => {
    const d = island();
    d.phase = "thinking";
    d.phaseDetail = null;
    d.elapsedSec = 5;
    expect(d.waitLabel()).toBe("thinking · 5s");
  });

  test("an unknown phase says nothing rather than guessing", () => {
    const d = island();
    // e.g. a stage a future CLI emits that this client does not know yet.
    d.phase = "compacting";
    d.elapsedSec = 1;
    expect(d.phaseLabel()).toBe("");
    expect(d.waitLabel()).toBe("");
  });

  test("a nonsense elapsed value degrades quietly instead of rendering nonsense", () => {
    // Not reachable today — the timer only ever assigns a non-negative integer.
    // Asserted anyway because the safety is structural (`NaN >= 3` and
    // `-1 >= 3` are both false, so the seconds are simply withheld) and that
    // is worth holding still: a later refactor to the comparison could turn
    // "quietly withheld" into "NaNs" without any other test noticing.
    const d = island();
    d.phase = "ready";
    d.elapsedSec = Number.NaN;
    expect(d.waitLabel()).toBe("asking siltpoke");

    d.elapsedSec = -4;
    expect(d.waitLabel()).toBe("asking siltpoke");

    d.phase = null;
    d.elapsedSec = Number.NaN;
    expect(d.waitLabel()).toBe("");
  });

  test("`writing` is NOT a phase this client renders — nothing produces it", () => {
    // Dropped with its dead producer. If a real event for it ever lands, this
    // assertion is the reminder to add the label back deliberately.
    const d = island();
    d.phase = "writing";
    d.elapsedSec = 1;
    expect(d.phaseLabel()).toBe("");
  });
});
