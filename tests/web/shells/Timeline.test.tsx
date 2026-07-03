/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Timeline } from "../../../src/web/shells/Timeline";
import { tokens } from "../../../src/web/tokens/tokens";

const EVENTS = [
  { time: "just now", title: "daemon started", tone: "success" as const },
  { time: "5m ago", title: "chat message", body: "hello", tone: "neutral" as const },
  { time: "1h ago", title: "error occurred", tone: "danger" as const },
];

describe("Timeline", () => {
  test("renders all event titles", () => {
    const html = String(
      <Timeline events={EVENTS} />,
    );
    expect(html).toContain("daemon started");
    expect(html).toContain("chat message");
    expect(html).toContain("error occurred");
  });

  test("renders event times", () => {
    const html = String(
      <Timeline events={EVENTS} />,
    );
    expect(html).toContain("just now");
    expect(html).toContain("5m ago");
  });

  test("renders event body when provided", () => {
    const html = String(
      <Timeline events={EVENTS} />,
    );
    expect(html).toContain("hello");
  });

  test("title uses SectionHead with TIMELINE kicker", () => {
    const html = String(
      <Timeline events={EVENTS} title="Activity" />,
    );
    expect(html).toContain("Activity");
    expect(html).toContain("TIMELINE");
  });

  test("outer container has height:100% and overflow:hidden", () => {
    const html = String(<Timeline events={EVENTS} />);
    expect(html).toContain("height:100%");
    expect(html).toContain("overflow:hidden");
  });

  test("scrollable body has flex:1 and overflow:auto", () => {
    const html = String(<Timeline events={EVENTS} />);
    expect(html).toContain("overflow:auto");
    // flex:1 for the scroll body
    expect(html).toContain("flex:1");
  });

  test("empty state renders EmptyPlaceholder with headline", () => {
    const html = String(
      <Timeline events={[]} emptySub="no events yet" />,
    );
    expect(html).toContain("nothing here yet");
    expect(html).toContain("no events yet");
  });

  test("empty state with custom art slot", () => {
    const html = String(
      <Timeline
        events={[]}
        emptyArt={<pre id="art">art</pre>}
        emptySub="nothing"
      />,
    );
    expect(html).toContain('id="art"');
  });

  test("success tone leaks moss color through TimelineEvent", () => {
    const html = String(
      <Timeline events={[{ time: "now", title: "ok", tone: "success" }]} />,
    );
    expect(html).toContain(tokens.color.moss);
  });

  test("danger tone leaks terra color through TimelineEvent", () => {
    const html = String(
      <Timeline events={[{ time: "now", title: "fail", tone: "danger" }]} />,
    );
    expect(html).toContain(tokens.color.terra);
  });

  test("last event suppresses vertical line (isLast=true)", () => {
    // TimelineEvent renders a connector div with `width:1` only when
    // !isLast. Counting `width:1` occurrences = N-1 for N events.
    const html = String(<Timeline events={EVENTS} />);
    const lineMatches = html.match(/width:\s*1px/g) ?? [];
    expect(lineMatches.length).toBe(EVENTS.length - 1);
  });

  test("single event renders zero connector lines", () => {
    // Edge case: a 1-event timeline is all-last → no connectors at all.
    const html = String(
      <Timeline events={[{ time: "now", title: "lonely", tone: "neutral" }]} />,
    );
    const lineMatches = html.match(/width:\s*1px/g) ?? [];
    expect(lineMatches.length).toBe(0);
  });

  test("no title section when title omitted", () => {
    const html = String(<Timeline events={EVENTS} />);
    expect(html).not.toContain("TIMELINE");
  });
});
