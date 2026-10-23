/**
 * Chat Runs window — the pane (spec 2026-10-13 §10.1): rows appended, never
 * re-rendered; selecting moves only the highlight; record text is escaped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mountRunsPanel, type RunsPanel } from "../../../../src/web/client/islands/chat-runs-panel";
import { makeRunsWindow, widthUnderPointer } from "../../../../src/web/client/islands/floating-chat-runs";
import { runRowHtml } from "../../../../src/web/client/lib/chat-runs-render";
import { buildRunView } from "../../../../src/web/client/lib/chat-runs-view";
import { baseRun, CLAUDE_OK_LINES, TOOL_LINES } from "../lib/chat-runs-fixtures";
import { registerDom, unregisterDom } from "./_dom-harness";

beforeAll(() => registerDom());
afterAll(async () => {
  await unregisterDom();
});

function paneDom(): HTMLElement {
  document.body.innerHTML = `<aside data-runs-root><div data-runs-sub></div><div data-runs-note hidden></div><div data-runs-list></div></aside>`;
  return document.querySelector<HTMLElement>("[data-runs-root]") as HTMLElement;
}

const RUN_1 = baseRun({ run_id: "r-1", message_id: "m-1", output: CLAUDE_OK_LINES });
const RUN_2 = baseRun({
  run_id: "r-2",
  message_id: "m-2",
  outcome: "failed",
  failure_message: "Timed out after 60 s.",
  total_ms: 60_000,
  output: TOOL_LINES,
});

function fetchReturning(...bodies: unknown[]): { fn: typeof fetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, urls, headers };
}

describe("the chat island's Runs half, in a page", () => {
  function chatDom(): void {
    localStorage.clear();
    document.body.innerHTML = `<div id="siltpoke-floating-chat"><div class="fc-panel"><aside data-runs-root><div data-runs-sub></div><div data-runs-note hidden></div><div data-runs-list></div></aside></div></div>`;
  }

  test("switching conversation clears the highlight — no false 'No record for this answer' (review round 1)", async () => {
    chatDom();
    let session = "s-1";
    const bySession = (async (url: string) =>
      Response.json({ runs: url.includes("s-1") ? [RUN_1] : [] })) as unknown as typeof fetch;
    const r = Object.assign(makeRunsWindow(bySession), {
      secret: "",
      maximized: false,
      active: () => ({ serverSessionId: session }),
    });
    r.toggleRuns();
    await r.syncRuns();
    r.selectAnswer("m-1");
    expect(document.querySelector(".cr-sel")).not.toBeNull();
    session = "s-2";
    await r.syncRuns();
    expect(r.selectedMsgId).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-runs-note]")?.textContent).not.toStartWith("No record for this answer");
  });

  const KEY = "siltpoke.chat.runsW";
  const setVw = (px: number) =>
    Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
  const runsWindow = (maximized = false) =>
    Object.assign(makeRunsWindow(fetchReturning({ runs: [] }).fn), { secret: "", maximized, active: () => null });

  test("a saved width wider than this window is clamped when Runs opens — and the saved one is kept", () => {
    chatDom();
    localStorage.setItem(KEY, "500");
    const r = runsWindow();
    expect(r.runsWidth).toBe(500);
    setVw(1000);
    r.toggleRuns();
    // Shown trimmed so the corner chat keeps 530; the stored width is untouched.
    expect(r.runsPanelStyle()).toContain(`--runs-w:${1000 - 40 - 530 - 7}px`);
    expect(r.runsWidth).toBe(500);
    expect(localStorage.getItem(KEY)).toBe("500");
    // The window grows again: the saved width shows in full (review round 3).
    setVw(1600);
    expect(r.runsPanelStyle()).toContain("--runs-w:500px");
    setVw(0);
  });

  test("a saved width from 340 up is kept; below 340 opens at the 340 default", () => {
    chatDom();
    const open = (saved: string) => {
      localStorage.setItem(KEY, saved);
      return runsWindow().runsWidth;
    };
    expect(open("400")).toBe(400);
    expect(open("500")).toBe(500);
    expect(open("339")).toBe(340);
  });

  test("a saved width over 560 opens at 560, however wide the window", () => {
    chatDom();
    localStorage.setItem(KEY, "800");
    const r = runsWindow();
    setVw(1920);
    r.toggleRuns();
    expect(r.runsWidth).toBe(560);
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1097px);--runs-w:560px");
    setVw(0);
  });

  test("a width saved under the old 480–800 key is ignored: Runs opens at 340", () => {
    chatDom();
    localStorage.setItem("siltpoke.chat.runsWidth", "480");
    const r = runsWindow();
    r.toggleRuns();
    expect(r.runsWidth).toBe(340);
  });

  test("a wide corner width is trimmed when maximized, and comes back on return", () => {
    chatDom();
    setVw(1300); // maximized leaves 1300 − 40 − 800 − 7 = 453 beside the chat
    const r = runsWindow();
    r.runsOpen = true;
    r.setRunsWidth(99_999); // 560, the most Runs gets; the corner has room for it
    expect(r.runsWidth).toBe(560);
    r.maximized = true;
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1260px);--runs-w:453px");
    expect(r.runsWidth).toBe(560);
    r.maximized = false;
    expect(r.runsPanelStyle()).toContain("--runs-w:560px");
    // a drag starts from the trimmed width, so the divider moves at once —
    // and pressing on the divider does not shrink the stored width
    r.maximized = true;
    r.gripDown({ clientX: 500, pointerId: 1, target: null } as unknown as PointerEvent);
    expect(r._gripDrag).toEqual({ x: 500, w: 453 });
    r.gripUp();
    expect(r.runsWidth).toBe(560);
    // closing and reopening while maximized keeps it too
    r.toggleRuns();
    r.toggleRuns();
    expect(r.runsWidth).toBe(560);
    r.maximized = false;
    expect(r.runsPanelStyle()).toContain("--runs-w:560px");
    expect(localStorage.getItem(KEY)).toBe("560");
    setVw(0);
  });

  test("arrow keys move from the trimmed width — no presses lost", () => {
    chatDom();
    setVw(1300);
    const r = runsWindow(true);
    r.runsWidth = 560; // set in the corner; 453 shows here
    r.gripKey({ key: "ArrowRight", preventDefault() {} } as KeyboardEvent);
    expect(r.runsWidth).toBe(413);
    setVw(0);
  });
});

describe("divider under the pointer (widthUnderPointer)", () => {
  // The divider's x for a Runs width, maximized: the panel is centred and
  // chat 800 + divider 7 + Runs wide, up to the window minus 40.
  const gripX = (vw: number, w: number) => (vw + Math.min(vw - 40, 807 + w)) / 2 - 7 - w;

  test("corner: 1:1 with the pointer", () => {
    expect(widthUnderPointer(false, 1400, { x: 700, w: 580 }, 650)).toBe(630);
  });

  test("maximized: the divider lands under the pointer, below and past the window edge, with no jump (review round 2)", () => {
    const vw = 1400;
    const start = { x: gripX(vw, 340), w: 340 };
    let prev = 340;
    // Walk the pointer left 1 px at a time across the point where the panel meets the window edge.
    for (let px = start.x; px > start.x - 300; px -= 1) {
      const w = widthUnderPointer(true, vw, start, px);
      expect(gripX(vw, w)).toBeCloseTo(px, 6);
      expect(Math.abs(w - prev)).toBeLessThanOrEqual(2);
      prev = w;
    }
    expect(prev).toBeGreaterThan(vw - 40 - 807); // went past the edge
  });

  test("maximized with the history pane open: the panel is 241 wider, the divider still lands under the pointer", () => {
    const vw = 1600;
    const gripH = (w: number) => (vw + Math.min(vw - 40, 241 + 807 + w)) / 2 - 7 - w;
    const start = { x: gripH(340), w: 340 };
    for (let px = start.x; px > start.x - 300; px -= 1) {
      expect(gripH(widthUnderPointer(true, vw, start, px, true))).toBeCloseTo(px, 6);
    }
    // Past the window edge (only reached with the pane open here) the flag
    // matters: 150 px left of the start, the two answers differ.
    expect(widthUnderPointer(true, vw, start, start.x - 150, false)).not.toBeCloseTo(
      widthUnderPointer(true, vw, start, start.x - 150, true),
      0,
    );
  });
});

describe("rendering one row", () => {
  test("record text is escaped — an answer cannot inject markup", () => {
    const evil = baseRun({
      output: [
        {
          t_ms: 10,
          line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '<img src=x onerror="alert(1)">' }] } }),
        },
      ],
    });
    const html = runRowHtml(buildRunView(evil, 0));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("a failed call opens What happened, the hanging step and the stop; an answered one keeps them closed", () => {
    const failed = runRowHtml(buildRunView(RUN_2, 1));
    expect(failed).toContain('<details class="cr-what" open>');
    expect(failed.match(/<details class="cr-evd" open>/g)).toHaveLength(2);
    const ok = runRowHtml(buildRunView(RUN_1, 0));
    expect(ok).not.toContain('<details class="cr-what" open>');
    expect(ok).not.toContain('<details class="cr-evd" open>');
  });
});

describe("the pane", () => {
  let root: HTMLElement;
  let picked: string[];
  beforeEach(() => {
    root = paneDom();
    picked = [];
  });

  function mount(fn: typeof fetch): RunsPanel {
    return mountRunsPanel(root, { fetchFn: fn, secret: () => "sek", onPick: (id) => picked.push(id) });
  }

  test("loads one conversation's records with the secret, oldest first", async () => {
    const f = fetchReturning({ runs: [RUN_1, RUN_2] });
    const panel = mount(f.fn);
    await panel.load("s-1");
    expect(f.urls).toEqual(["/api/chat/sessions/s-1/runs"]);
    expect(f.headers[0]?.["X-Siltpoke-Secret"]).toBe("sek");
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".cr-run"));
    expect(rows.map((r) => r.dataset.messageId)).toEqual(["m-1", "m-2"]);
    expect(rows[0]?.textContent).toContain("#1");
    expect(root.querySelector("[data-runs-sub]")?.textContent).toBe("This conversation · 2 calls");
  });

  test("a new record is appended; rows already on screen keep what was opened in them", async () => {
    const f = fetchReturning({ runs: [RUN_1] }, { runs: [RUN_1, RUN_2] });
    const panel = mount(f.fn);
    await panel.load("s-1");
    const first = root.querySelector<HTMLElement>(".cr-run") as HTMLElement;
    const what = first.querySelector<HTMLDetailsElement>("details.cr-what") as HTMLDetailsElement;
    what.open = true;
    await panel.load("s-1");
    const rows = root.querySelectorAll(".cr-run");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(first);
    expect(what.open).toBe(true);
  });

  test("switching conversation replaces the list", async () => {
    const f = fetchReturning({ runs: [RUN_1] }, { runs: [] });
    const panel = mount(f.fn);
    await panel.load("s-1");
    await panel.load("s-2");
    expect(root.querySelectorAll(".cr-run")).toHaveLength(0);
    expect(root.querySelector("[data-runs-note]")?.textContent).toBe("No calls recorded in this conversation yet.");
  });

  test("selecting moves only the highlight — the row node and its open steps stay", async () => {
    const panel = mount(fetchReturning({ runs: [RUN_1, RUN_2] }).fn);
    await panel.load("s-1");
    const second = root.querySelectorAll<HTMLElement>(".cr-run")[1] as HTMLElement;
    const openSteps = second.querySelectorAll("details[open]").length;
    expect(panel.select("m-2")).toBe(true);
    expect(second.classList.contains("cr-sel")).toBe(true);
    expect(root.querySelectorAll(".cr-sel")).toHaveLength(1);
    panel.select("m-1");
    expect(root.querySelectorAll<HTMLElement>(".cr-run")[1]).toBe(second);
    expect(second.classList.contains("cr-sel")).toBe(false);
    expect(second.querySelectorAll("details[open]").length).toBe(openSteps);
  });

  test("an answer with no record says so", async () => {
    const panel = mount(fetchReturning({ runs: [RUN_1] }).fn);
    await panel.load("s-1");
    expect(panel.select("m-old")).toBe(false);
    const note = root.querySelector<HTMLElement>("[data-runs-note]") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toStartWith("No record for this answer.");
    panel.select("m-1");
    expect(note.hidden).toBe(true);
  });

  test("clicking a row highlights it and tells the chat side", async () => {
    const panel = mount(fetchReturning({ runs: [RUN_1, RUN_2] }).fn);
    await panel.load("s-1");
    (root.querySelectorAll<HTMLElement>(".cr-l1")[1] as HTMLElement).click();
    expect(picked).toEqual(["m-2"]);
    expect(root.querySelectorAll<HTMLElement>(".cr-run")[1]?.classList.contains("cr-sel")).toBe(true);
  });

  test("Open all steps / Close all; { } shows the exact line", async () => {
    const panel = mount(fetchReturning({ runs: [RUN_1] }).fn);
    await panel.load("s-1");
    const row = root.querySelector<HTMLElement>(".cr-run") as HTMLElement;
    (row.querySelector('[data-steps="open"]') as HTMLElement).click();
    const steps = Array.from(row.querySelectorAll<HTMLDetailsElement>(".cr-evd"));
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.every((d) => d.open)).toBe(true);
    expect(row.querySelector<HTMLDetailsElement>("details.cr-what")?.open).toBe(true);
    (row.querySelector('[data-steps="close"]') as HTMLElement).click();
    expect(steps.some((d) => d.open)).toBe(false);
    const raw = row.querySelector<HTMLElement>(".cr-rawbtn") as HTMLElement;
    const pre = raw.nextElementSibling as HTMLElement;
    expect(pre.hidden).toBe(true);
    raw.click();
    expect(pre.hidden).toBe(false);
    expect(pre.textContent).toContain('"subtype": "hook_started"');
    expect(picked).toEqual([]);
  });

  test("Copy whole prompt / record / output copy the right text", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    const panel = mount(fetchReturning({ runs: [RUN_1] }).fn);
    await panel.load("s-1");
    const view = buildRunView(RUN_1, 0);
    for (const kind of ["prompt", "record", "output"]) {
      (root.querySelector(`[data-copy="${kind}"]`) as HTMLElement).click();
    }
    await Promise.resolve();
    expect(written).toEqual([view.wholePrompt, view.rawRecord, view.rawOutput]);
  });

  test("calls fetch as a plain function — the browser's fetch rejects any other `this`", async () => {
    // Found on the real page 2026-10-16: `deps.fetchFn(…)` threw "Illegal invocation".
    const strict = function (this: unknown, _url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ runs: [RUN_1] }));
    } as unknown as typeof fetch;
    const panel = mount(strict);
    await panel.load("s-1");
    expect(root.querySelectorAll(".cr-run")).toHaveLength(1);
    expect(root.querySelector<HTMLElement>("[data-runs-note]")?.hidden).toBe(true);
  });

  test("a record this window cannot read does not hide the others", async () => {
    const broken = { ...RUN_1, run_id: "r-bad", message_id: "m-bad", prompt_blocks: null } as unknown;
    const f = fetchReturning({ runs: [broken, RUN_2] }, { runs: [broken, RUN_2] });
    const panel = mount(f.fn);
    await panel.load("s-1");
    await panel.load("s-1");
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".cr-run"));
    expect(rows.map((r) => r.dataset.runId)).toEqual(["r-bad", "r-2"]);
    expect(rows[0]?.textContent).toContain("This record could not be shown:");
    expect(rows[1]?.textContent).toContain("Total runtime");
  });

  test("a failed fetch says so instead of showing an empty list", async () => {
    const fn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const panel = mount(fn);
    await panel.load("s-1");
    expect(root.querySelector("[data-runs-note]")?.textContent).toBe("Could not load the records (HTTP 401).");
  });
});
