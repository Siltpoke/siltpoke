/** @jsxImportSource hono/jsx */
/**
 * Memory screen SSR tests — timeline replaces Kanban.
 *
 * These tests verify the SSR output of the Memory timeline component.
 * The screen accepts `events: MemoryEvent[]`, `secret: string`, and
 * `recentChats: ChatSession[]` props (working-memory panel).
 *
 * IMPORTANT: `x-for` and `x-text` are Alpine directives — they produce
 * client-rendered content, NOT SSR content. Tests check the SSR scaffold
 * (Alpine binding strings, HTML-encoded `data-memories` JSON attribute)
 * rather than Alpine-evaluated text/attribute values.
 *
 * data-memories JSON is HTML-encoded in the SSR string:
 *   `"` → `&quot;`  so id "evt-0001" appears as: &quot;evt-0001&quot;
 *   The raw value (e.g. "evt-0001") still matches via `.toContain` since
 *   it's a substring of the encoded form.
 */
import { describe, expect, test } from "bun:test";
import type { ChatSession } from "../../../src/memory/memory";
import type { MemoryEvent } from "../../../src/memory/memory-log";
import { Memory } from "../../../src/web/screens/Memory";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "evt-0001",
    ts: "2026-06-10T12:00:00.000Z",
    type: "semantic",
    text: "user prefers terse responses",
    why: "explicit preference",
    status: "active",
    recall_count: 0,
    last_confirmed_at: null,
    events: [],
    supersedes: null,
    superseded_by: null,
    ...overrides,
  };
}

const SAMPLE_EVENTS: MemoryEvent[] = [
  makeEvent({
    id: "evt-0001",
    ts: "2026-06-10T12:00:00.000Z",
    type: "semantic",
    text: "user prefers terse responses",
    why: "explicit preference",
    status: "active",
  }),
  makeEvent({
    id: "evt-0002",
    ts: "2026-06-09T08:30:00.000Z",
    type: "episodic",
    text: "Added TypeScript strict config",
    why: null,
    status: "active",
  }),
  makeEvent({
    id: "evt-0003",
    ts: "2026-05-01T00:00:00.000Z",
    type: "procedural",
    text: "Always run tsc before commit",
    why: "rule from eslint-discussion",
    status: "retired",
  }),
];

const SAMPLE_CHAT: ChatSession = {
  id: "cs-test-001",
  started_at: "2026-06-25T10:00:00.000Z",
  ended_at: "2026-06-25T10:30:00.000Z",
  message_count: 5,
  summary: "Discussed memory book UI",
  summary_generated_at: null,
  tags: ["memory"],
  anchor: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function render(
  events: MemoryEvent[] = SAMPLE_EVENTS,
  secret = "test-secret",
  recentChats: ChatSession[] = [],
): string {
  return String(<Memory events={events} secret={secret} recentChats={recentChats} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Memory screen SSR — timeline", () => {
  test("renders the memory-book container with x-data=memoryBook", () => {
    const html = render();
    expect(html).toContain('x-data="memoryBook"');
    expect(html).toContain('class="memory-book"');
  });

  test("embeds events JSON in data-memories attribute", () => {
    const html = render();
    expect(html).toContain("data-memories=");
    // Event IDs appear in the HTML-encoded JSON blob (raw values are substrings
    // of the encoded form, e.g. "evt-0001" in &quot;evt-0001&quot;)
    expect(html).toContain("evt-0001");
    expect(html).toContain("evt-0002");
    expect(html).toContain("evt-0003");
  });

  test("embeds secret in data-secret attribute", () => {
    const html = render(SAMPLE_EVENTS, "my-secret-xyz");
    expect(html).toContain('data-secret="my-secret-xyz"');
  });

  test("renders the memory-timeline container", () => {
    const html = render();
    expect(html).toContain('class="memory-timeline"');
  });

  test("Alpine x-for row template scaffold is present with data-event-id binding", () => {
    const html = render();
    // Events fed via data-memories (JSON); Alpine hydrates x-for at runtime.
    // SSR output has the binding attribute; actual row ids are in data-memories.
    expect(html).toContain('x-bind:data-event-id="event.id"');
    // Raw IDs appear in the HTML-encoded data-memories JSON blob
    expect(html).toContain("evt-0001");
    expect(html).toContain("evt-0002");
    expect(html).toContain("evt-0003");
  });

  test("Alpine x-for row template contains type tag and status badge bindings", () => {
    const html = render();
    // x-for renders the template at Alpine runtime; SSR emits structural classes.
    expect(html).toContain('class="memory-row-type"');
    expect(html).toContain('class="memory-row-status"');
  });

  test("each row's event text is serialised in data-memories JSON", () => {
    const html = render();
    // Text content lives in data-memories; x-text renders it at Alpine runtime.
    expect(html).toContain("user prefers terse responses");
    expect(html).toContain("Added TypeScript strict config");
    expect(html).toContain("Always run tsc before commit");
  });

  test("timestamp is serialised in ISO format in data-memories", () => {
    const html = render([makeEvent({ ts: "2026-06-10T12:00:00.000Z" })]);
    // The ISO ts is in data-memories; Alpine derives the HH:MM at runtime
    // (precomputed in decorateRow → event.time).
    expect(html).toContain("2026-06-10T12:00:00.000Z");
    // x-text binding for the time gutter is present in the template scaffold
    expect(html).toContain('x-text="event.time"');
  });

  test("empty events produces empty data-memories; empty-state binding is present", () => {
    const html = render([]);
    // data-memories="[]" — confirms 0 events are passed; [] has no special chars
    expect(html).toContain("data-memories=\"[]\"");
    // Alpine x-show / x-text scaffold for the empty-state div is present in SSR
    expect(html).toContain('class="memory-empty-state"');
    expect(html).toContain('x-text="emptyMessage()"');
  });

  // An episodic event fragment (occurred_at as ts, stream+entities carried)
  // must round-trip through the SSR payload so the island renders it in the
  // episodic slot alongside critiques.
  test("an episodic event-fragment row round-trips into data-memories", () => {
    const html = render([
      makeEvent({
        id: "ev-frag-01",
        type: "episodic",
        text: "Refactored the Qwzzptl module",
        ts: "2026-06-14T00:00:00.000Z",
        stream: "commit",
        entities: [{ name: "Qwzzptl" }],
        why: "from commit abc1234d",
      }),
    ]);
    // Distinctive token only reachable via the serialised event-fragment payload.
    expect(html).toContain("Qwzzptl");
    expect(html).toContain("ev-frag-01");
    expect(html).toContain("data-memories=");
  });

  test("does not render kanban elements", () => {
    const html = render();
    expect(html).not.toContain("kanban");
    expect(html).not.toContain("data-lane-id");
    expect(html).not.toContain("fact-list");
  });

  test("Memory nav entry is active (Dashboard wired correctly)", () => {
    const html = render();
    expect(html).toContain("Memory");
  });

  test("no nav entry renders disabled (placeholders removed 2026-07-02)", () => {
    const html = render();
    expect(html).not.toContain('aria-disabled="true"');
  });
});

describe("Memory screen SSR — working-memory panel", () => {
  test("renders the working-memory panel outside the memory-timeline", () => {
    const html = render(SAMPLE_EVENTS, "test-secret", [SAMPLE_CHAT]);
    expect(html).toContain('class="working-memory-panel"');
    expect(html).toContain("Working Memory");
  });

  test("shows a chat session's summary in the panel", () => {
    const html = render(SAMPLE_EVENTS, "test-secret", [SAMPLE_CHAT]);
    expect(html).toContain("Discussed memory book UI");
  });

  test("shows empty state when no chat sessions", () => {
    const html = render(SAMPLE_EVENTS, "test-secret", []);
    expect(html).toContain('class="working-memory-empty"');
    expect(html).toContain("No chat history yet");
  });

  test("working-memory panel HTML is not nested inside the memory-timeline section", () => {
    const html = render(SAMPLE_EVENTS, "test-secret", [SAMPLE_CHAT]);
    const timelineStart = html.indexOf('class="memory-timeline"');
    const panelIdx = html.indexOf('class="working-memory-panel"');
    // Both must exist
    expect(timelineStart).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(-1);
    // The timeline open tag appears before the panel in DOM order —
    // the panel is a sibling of the timeline, not a child.
    const sliceBeforePanel = html.slice(timelineStart, panelIdx);
    expect(sliceBeforePanel).toContain('class="memory-timeline"');
    // The panel must not appear before its own index in that slice
    expect(sliceBeforePanel).not.toContain('class="working-memory-panel"');
  });

  test("panel does not contain forget buttons", () => {
    const html = render(SAMPLE_EVENTS, "test-secret", [SAMPLE_CHAT]);
    // Extract the <aside> element's HTML
    const panelStart = html.indexOf('<aside');
    const panelEnd = html.indexOf("</aside>", panelStart) + "</aside>".length;
    const panelHtml = html.slice(panelStart, panelEnd);
    expect(panelHtml).not.toContain("memory-row-forget");
  });
});

describe("Memory screen SSR — by-entity view", () => {
  test("hides the 实体 view toggle button (entry removed; grouping logic kept)", () => {
    const html = render();
    // The entity-view ENTRY button is intentionally hidden from the selector
    // (Memory.tsx comment "实体 (entity) view hidden — Restore this block to
    // re-expose the entity tab"). The byEntityGroups scaffold + island logic
    // remain (next test) so restoring is a one-block revert. `setView('entity')`
    // was ONLY the button's click handler — the scaffold uses `view === 'entity'`
    // (x-show), so its absence specifically proves the button is gone, not the
    // grouping. This assertion fails the moment the button is restored.
    expect(html).not.toContain("setView(&#39;entity&#39;)");
    expect(html).not.toContain("实体");
  });

  test("renders the byEntityGroups x-for scaffold gated on view === 'entity'", () => {
    const html = render();
    expect(html).toContain("x-show=\"view === &#39;entity&#39;\"");
    expect(html).toContain('x-for="group in byEntityGroups()"');
    expect(html).toContain('x-text="group.label"');
  });

  // The load-bearing wiring: the fact projection (buildMemoryLog → MemoryEvent
  // → this `events` prop → data-memories JSON) must carry `entities`, or the
  // island's byEntityGroups() has nothing to group by.
  test("projected facts include the entities field for the island", () => {
    const html = render([
      makeEvent({
        id: "f1",
        text: "user prefers terse responses",
        entities: [{ name: "Zzyzx" }],
      }),
    ]);
    // "Zzyzx" is a distinctive token disjoint from the fact's text/why/id/etc,
    // so it can only reach the HTML-encoded data-memories JSON blob via the
    // `entities` field — proves the SSR payload genuinely carries entities,
    // not just that the fact's own text happens to repeat in the assertion.
    expect(html).toContain("Zzyzx");
    expect(html).toContain("data-memories=");
  });

  test("a fact with no entities still round-trips (untagged, no migration needed)", () => {
    const html = render([makeEvent({ id: "f1", text: "no entity here" })]);
    expect(html).toContain("no entity here");
  });
});
