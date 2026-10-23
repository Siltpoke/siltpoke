// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// On page load the panel restores the most recent conversation in the
// background (loadSessions → openConversation → a fetch of its messages).
// Opening a conversation used to close the "Past chats" list — wrong when the
// background restore finished after the user had opened the list: it snapped
// shut under the pointer. Seen as an intermittent e2e failure (csh-01, csh-03:
// the row "resolved" but "hidden"). The list is now a pane that no pick
// closes; these tests keep the restore from closing it again.

import { describe, expect, test } from "bun:test";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";

const SESSION = {
  id: "s-hist",
  anchor: null,
  label: "Chat",
  pin: "",
  badge: "",
  title: "first question",
  message_count: 2,
  started_at: "2026-07-02T10:00:00.000Z",
};
const ROWS = [
  { role: "user", text: "first question" },
  { role: "assistant", text: "an answer" },
];

/** A fake server whose messages reply waits until the test releases it. */
function gatedFetch(): { fetchFn: typeof fetch; asked: Promise<void>; release: () => void } {
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((r) => {
    markAsked = r;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fetchFn = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/chat/sessions")) return Response.json({ sessions: [SESSION] });
    if (u.includes("/api/chat/sessions/s-hist/messages")) {
      markAsked();
      await gate;
      return Response.json({ messages: ROWS });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { fetchFn, asked, release };
}

function make(fetchFn: typeof fetch, recallEnabled = false) {
  return makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null, recallEnabled });
}

describe("the background restore does not close a list the user opened", () => {
  test("Past chats opened while the restore is still fetching stays open", async () => {
    const { fetchFn, asked, release } = gatedFetch();
    const d = make(fetchFn);
    const loading = d.loadSessions();
    await asked; // the restore is now waiting on the messages
    d.toggleHistory();
    expect(d.historyOpen).toBe(true);
    release();
    await loading;
    // Not vacuous: the restore did finish and did load the conversation.
    expect(d.active()?.messages).toHaveLength(2);
    expect(d.historyOpen).toBe(true);
  });

  test("the recall dropdown opened during the restore stays open too", async () => {
    const { fetchFn, asked, release } = gatedFetch();
    const d = make(fetchFn, true);
    const loading = d.loadSessions();
    await asked;
    d.toggleRecall();
    expect(d.recallOpen).toBe(true); // not vacuous: recall is enabled here
    release();
    await loading;
    expect(d.recallOpen).toBe(true);
  });

  test("a new chat started during the restore stays the one on screen", async () => {
    const { fetchFn, asked, release } = gatedFetch();
    const d = make(fetchFn);
    const loading = d.loadSessions();
    await asked;
    d.newConversation();
    const mine = d.activeId;
    expect(mine).not.toBe(d.conversations.find((c) => c.title === "first question")?.id);
    release();
    await loading;
    expect(d.activeId).toBe(mine);
    // The restored conversation still got its messages — it is just not forced on screen.
    expect(d.conversations.find((c) => c.title === "first question")?.messages).toHaveLength(2);
  });

  // The list is now a pane beside the chat: picking a conversation keeps it
  // open; only the clock button closes it.
  test("picking a conversation from the history pane keeps the pane open", async () => {
    const { fetchFn, release } = gatedFetch();
    release();
    const d = make(fetchFn);
    await d.loadSessions();
    d.toggleHistory();
    expect(d.historyOpen).toBe(true);
    await d.openConversation(d.conversations[0]!.id);
    expect(d.activeId).toBe(d.conversations[0]!.id);
    expect(d.historyOpen).toBe(true);
    d.toggleHistory();
    expect(d.historyOpen).toBe(false);
  });

  // The early return is for the background restore only. A conversation the
  // user picked is shown when its messages arrive, as before this change.
  test("a conversation the user picked is still shown, whatever happened while it loaded", async () => {
    const second = { ...SESSION, id: "s-two", title: "second question" };
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    let secondAsked: () => void = () => {};
    const asked = new Promise<void>((r) => {
      secondAsked = r;
    });
    const fetchFn = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/chat/sessions")) return Response.json({ sessions: [SESSION, second] });
      if (u.includes("/api/chat/sessions/s-two/messages")) {
        secondAsked();
        await secondGate;
        return Response.json({ messages: ROWS });
      }
      if (u.includes("/messages")) return Response.json({ messages: ROWS });
      return Response.json({});
    }) as unknown as typeof fetch;
    const d = make(fetchFn);
    await d.loadSessions();
    const picked = d.conversations.find((c) => c.title === "second question")!;
    const opening = d.openConversation(picked.id);
    await asked;
    d.newConversation(); // activeId changes while the pick is loading
    releaseSecond();
    await opening;
    expect(d.activeId).toBe(picked.id);
  });
});
