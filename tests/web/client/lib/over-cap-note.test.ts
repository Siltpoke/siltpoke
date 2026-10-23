import { describe, expect, test } from "bun:test";
import { overCapHtml, withOverCapNote } from "../../../../src/web/client/lib/over-cap-note";

// Driven through the two exported entry points; the note text itself is
// private to the module (defect [38]).
const HINT = "Diagram is current";
const note = (costUsd: number | null | undefined, hardCapUsd?: number) =>
  withOverCapNote(HINT, { costUsd, hardCapUsd });

describe("over-cap note (defect [38])", () => {
  test("over the cap → names the cost, the cap, and that the result was kept", () => {
    const text = note(2.3, 2);
    expect(text.startsWith(`${HINT} · `)).toBe(true);
    expect(text).toContain("$2.30");
    expect(text).toContain("$2.00");
    expect(text).toContain("kept");
  });

  test("exactly at the cap → no note (matches the server's strict `>`)", () => {
    expect(note(0.1, 0.1)).toBe(HINT);
  });

  test("under the cap → no note", () => {
    expect(note(0.05, 0.1)).toBe(HINT);
  });

  test("no recorded cost → no note, never read as over or as $0", () => {
    expect(note(null, 0.1)).toBe(HINT);
    expect(note(undefined, 0.1)).toBe(HINT);
  });

  test("no cap (legacy payload) or no payload → no note", () => {
    expect(note(5, undefined)).toBe(HINT);
    expect(withOverCapNote(HINT, null)).toBe(HINT);
  });
});

describe("overCapHtml", () => {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  test("over the cap → one data-over-cap element carrying the same note text", () => {
    const html = overCapHtml({ costUsd: 0.15, hardCapUsd: 0.1 }, "div", "ph-cite", esc);
    const text = note(0.15, 0.1).slice(`${HINT} · `.length);
    expect(html).toBe(`<div class="ph-cite" data-over-cap>⚠ ${text}</div>`);
  });
  test("under the cap or no cost → empty string", () => {
    expect(overCapHtml({ costUsd: 0.05, hardCapUsd: 0.1 }, "span", "ex-guard", esc)).toBe("");
    expect(overCapHtml({ costUsd: null, hardCapUsd: 0.1 }, "span", "ex-guard", esc)).toBe("");
  });
});
