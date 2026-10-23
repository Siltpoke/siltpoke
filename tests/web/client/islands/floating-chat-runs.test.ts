/**
 * Chat Runs window — the chat island's half (spec 2026-10-13 §10.1): answer
 * ids reach the client, the Runs button / split frame / divider width, and
 * timestamps on the bubbles. Factory + SSR markup; no Alpine runtime.
 */
import { describe, expect, test } from "bun:test";
import { CHAT_RUNS_CSS } from "../../../../src/web/_shared/chat-runs-css";
import { FloatingChat } from "../../../../src/web/_shared/FloatingChat";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";
import {
  makeRunsWindow,
  RUNS_DEFAULT_PX,
  RUNS_MAX_PX,
  RUNS_MIN_PX,
  runEventMessageId,
  runsMaxWidth,
} from "../../../../src/web/client/islands/floating-chat-runs";

const SSE_HEADERS = { "content-type": "text/event-stream", "X-Siltpoke-Session-Id": "s-runs" };

function streamFetch(sse: string): typeof fetch {
  return ((url: string) => {
    if (String(url).includes("/api/chat/context-preview")) {
      return Promise.resolve(Response.json({ node: null, page: "/", facts: 0 }));
    }
    return Promise.resolve(new Response(sse, { headers: SSE_HEADERS }));
  }) as unknown as typeof fetch;
}

const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("answer ids reach the client", () => {
  test("a live answer takes its id from the `run` event; both bubbles get a time", async () => {
    const d = makeFloatingChatData(
      streamFetch(event("content_block_delta", { text: "hi" }) + event("run", { run_id: "r-9", message_id: "ans-9", recorded: true })),
      { onGraph: () => false, getViewed: () => null },
    );
    d.newConversation();
    d.draft = "hello";
    await d.send();
    const [user, answer] = d.active()?.messages ?? [];
    expect(answer).toMatchObject({ role: "assistant", text: "hi", id: "ans-9" });
    expect(Number.isNaN(Date.parse(answer?.at ?? ""))).toBe(false);
    expect(user?.role).toBe("user");
    expect(Number.isNaN(Date.parse(user?.at ?? ""))).toBe(false);
  });

  test("a failed answer is linked to its record too", async () => {
    const d = makeFloatingChatData(
      streamFetch(event("error", { reason: "timeout" }) + event("run", { run_id: "r-8", message_id: "ans-8", recorded: true })),
      { onGraph: () => false, getViewed: () => null },
    );
    d.newConversation();
    d.draft = "hello";
    await d.send();
    expect(d.active()?.messages.at(-1)).toMatchObject({ status: "failed", id: "ans-8" });
  });

  test("history rows keep id + ts", async () => {
    const fetchFn = ((url: string) => {
      if (String(url).includes("/messages")) {
        return Promise.resolve(
          Response.json({
            messages: [
              { id: "m-1", ts: "2026-10-16T10:00:00Z", role: "user", text: "q" },
              { id: "m-2", ts: "2026-10-16T10:00:05Z", role: "assistant", text: "a" },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ sessions: [] }));
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, label: "x", pin: "", messages: [], count: 2 } as never,
    ];
    await d.openConversation("c1");
    expect(d.active()?.messages).toEqual([
      { role: "user", text: "q", id: "m-1", at: "2026-10-16T10:00:00Z" },
      { role: "assistant", text: "a", id: "m-2", at: "2026-10-16T10:00:05Z" },
    ]);
  });

  test("runEventMessageId ignores a malformed event", () => {
    expect(runEventMessageId('{"message_id":"m-1"}')).toBe("m-1");
    expect(runEventMessageId('{"message_id":""}')).toBeUndefined();
    expect(runEventMessageId("not json")).toBeUndefined();
  });
});

describe("Runs width and frame", () => {
  function runs(maximized = false) {
    const r = makeRunsWindow(fetch);
    return Object.assign(r, { secret: "", maximized, historyOpen: false, active: () => null });
  }

  test("closed: no inline width; open: chat column + divider + Runs, capped by the window", () => {
    const r = runs();
    expect(r.runsPanelStyle()).toBe("");
    r.runsOpen = true;
    expect(r.runsWidth).toBe(RUNS_DEFAULT_PX);
    // corner: chat 530 + divider 7 + Runs 340
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 877px);--runs-w:340px");
    const m = runs(true);
    m.runsOpen = true;
    // maximized: chat 800 + divider 7 + Runs 340
    expect(m.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1147px);--runs-w:340px");
  });

  test("Runs is 340 to 560, and never narrows the chat column", () => {
    // no window here: the viewport reads as 1440 px
    const r = runs();
    r.setRunsWidth(300);
    expect(r.runsWidth).toBe(RUNS_MIN_PX);
    r.setRunsWidth(520);
    expect(r.runsWidth).toBe(520);
    r.setRunsWidth(99_999);
    expect(r.runsWidth).toBe(RUNS_MAX_PX);
    expect(r.runsPanelStyle()).toBe("");
    r.runsOpen = true;
    // corner: chat 530 + divider 7 + Runs 560; the window had room for 863
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1097px);--runs-w:560px");
    // maximized: the window leaves 593 beside the 800 chat, more than 560
    const m = runs(true);
    m.setRunsWidth(99_999);
    expect(m.runsWidth).toBe(560);
  });

  test("the history pane widens the panel by 241, alone or beside Runs; the chat keeps its width", () => {
    const r = runs();
    r.historyOpen = true;
    // corner: history 240 + line 1 + chat 530
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 771px)");
    r.runsOpen = true;
    // + divider 7 + Runs 340
    expect(r.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1118px);--runs-w:340px");
    const m = runs(true);
    m.historyOpen = true;
    expect(m.runsPanelStyle()).toBe("width:min(calc(100vw - 40px), 1041px)");
    // maximized at 1440 with history open: Runs has 1440 − 40 − 241 − 800 − 7 = 352
    m.runsOpen = true;
    m.setRunsWidth(99_999);
    expect(m.runsWidth).toBe(352);
    expect(runsMaxWidth(true, 1440, true)).toBe(352);
    expect(runsMaxWidth(true, 1440, false)).toBe(RUNS_MAX_PX);
    // history closed again: nothing inline unless Runs is open
    r.historyOpen = false;
    r.runsOpen = false;
    expect(r.runsPanelStyle()).toBe("");
  });

  test("Runs opens at its narrowest, 340, and stops at 560", () => {
    expect(RUNS_DEFAULT_PX).toBe(340);
    expect(RUNS_DEFAULT_PX).toBe(RUNS_MIN_PX);
    expect(RUNS_MAX_PX).toBe(560);
  });

  test("runsMaxWidth: at most 560, leaves each mode's chat width, never below 340", () => {
    expect(runsMaxWidth(false, 1440)).toBe(RUNS_MAX_PX);
    expect(runsMaxWidth(true, 1440)).toBe(RUNS_MAX_PX);
    // a wide window does not let Runs fill it
    expect(runsMaxWidth(false, 1920)).toBe(RUNS_MAX_PX);
    expect(runsMaxWidth(true, 1920)).toBe(RUNS_MAX_PX);
    // a narrower window: the 800 chat keeps its width, Runs gets what is left
    expect(runsMaxWidth(true, 1300)).toBe(1300 - 40 - 800 - 7);
    expect(runsMaxWidth(false, 1000)).toBe(1000 - 40 - 530 - 7);
    expect(runsMaxWidth(true, 1000)).toBe(RUNS_DEFAULT_PX);
  });

  test("arrow keys move the divider; Home resets", () => {
    const r = runs();
    const key = (k: string) => ({ key: k, preventDefault() {} }) as KeyboardEvent;
    // opens at the narrowest: wider a step at a time, never narrower
    r.gripKey(key("ArrowLeft"));
    expect(r.runsWidth).toBe(380);
    r.gripKey(key("ArrowLeft"));
    r.gripKey(key("ArrowRight"));
    expect(r.runsWidth).toBe(380);
    r.gripKey(key("Home"));
    expect(r.runsWidth).toBe(RUNS_DEFAULT_PX);
    r.gripKey(key("ArrowRight"));
    expect(r.runsWidth).toBe(RUNS_MIN_PX);
  });

  test("bubble time is local HH:MM:SS; unknown is empty", () => {
    const r = runs();
    const d = new Date(2026, 9, 16, 9, 5, 7);
    expect(r.msgTime(d.toISOString())).toBe("09:05:07");
    expect(r.msgTime(undefined)).toBe("");
  });
});

describe("scrollbars", () => {
  test("thin, Timeline-style scrollbars, scoped to the chat panel", () => {
    const css = CHAT_RUNS_CSS;
    expect(css).toContain("#siltpoke-floating-chat *{scrollbar-width:thin;scrollbar-color:var(--color-edge) transparent}");
    expect(css).toContain("#siltpoke-floating-chat ::-webkit-scrollbar{width:8px;height:8px}");
    expect(css).toContain("#siltpoke-floating-chat ::-webkit-scrollbar-thumb{background:var(--color-edge);border-radius:4px}");
    // every scrollbar rule is scoped: none reaches the rest of the page
    const rules = css.split("}").filter((r) => r.includes("scrollbar"));
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const r of rules) expect(r.trim()).toStartWith("#siltpoke-floating-chat ");
  });
});

describe("markup", () => {
  const html = String(FloatingChat({ secret: "s" }));

  test("Runs button in the header, the divider and the pane", () => {
    expect(html).toContain('data-testid="chat-runs-button"');
    expect(html).toContain('x-on:click="toggleRuns()"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuemin="340"');
    expect(html).toContain('aria-valuemax="560"');
    expect(html).toContain('x-on:dblclick="setRunsWidth(340)"');
    // Runs closes from its header button only: no ✕ in the pane
    expect(html).not.toContain("Close runs");
  });

  test("history is a pane left of the chat, opened by the clock button with the Runs-style ring", () => {
    const pane = html.indexOf('data-testid="chat-history-pane"');
    expect(pane).toBeGreaterThan(-1);
    // before the chat column
    expect(pane).toBeLessThan(html.indexOf('class="fc-chat"'));
    expect(html).toMatch(/<aside class="fc-hist" x-show="historyOpen"/);
    expect(html).toContain('x-for="g in historyGroups()"');
    expect(html).toContain('x-on:click="openConversation(r.id)"');
    expect(html).toContain('x-on:click.stop="deleteConversation(r.id)"');
    expect(html).toContain(':aria-expanded="historyOpen ? &#39;true&#39; : &#39;false&#39;"');
    expect(html).toContain("(historyOpen ? &#39;;border-color:var(--color-sky)&#39; : &#39;&#39;)");
    // the old dropdown is gone: nothing closes history on an outside click
    expect(html).not.toContain('x-on:click.outside="historyOpen = false"');
    expect(html).not.toContain("sortedConversations()");
  });

  test("the panel is as wide as the chat column: 530 in the corner, 800 maximized", () => {
    expect(html).toContain("w-[min(530px,calc(100vw_-_40px))]");
    expect(html).toContain("w-[min(800px,92vw)]");
    expect(html).not.toContain("w-96");
    expect(html).not.toContain("880px");
    expect(html).toContain("data-runs-root");
    expect(html).toMatch(/data-runs-list[^>]*x-ignore/);
  });

  test("bubbles carry the answer id and a timestamp, not a model label", () => {
    expect(html).toContain(':data-msg-id="m.id || null"');
    expect(html).toContain('x-text="msgTime(m.at)"');
  });
});
