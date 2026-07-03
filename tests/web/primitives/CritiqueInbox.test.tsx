/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { CritiqueInbox } from "../../../src/web/primitives/CritiqueInbox";
import type { Critique } from "../../../src/web/primitives/CritiqueInbox";
import { MOCK_CRITIQUES } from "../../../src/web/_shared/mocks/critiques";

describe("CritiqueInbox", () => {
  test("renders CRITIQUE INBOX header", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain("CRITIQUE INBOX");
  });

  test("critique-inbox class on root element", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain('class="critique-inbox"');
  });

  test("renders pending count pill with correct count", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain("7 pending");
    expect(html).toContain("critique-inbox__pending");
  });

  test("renders up to max=4 critique rows (default) — 3 shown when only 3 available", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    const rowMatches = html.match(/class="critique-row"/g) ?? [];
    expect(rowMatches).toHaveLength(3); // MOCK_CRITIQUES has 3 items; max=4 → all 3 shown
  });

  test("respects custom max prop", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} max={1} />);
    const rowMatches = html.match(/class="critique-row"/g) ?? [];
    expect(rowMatches).toHaveLength(1);
  });

  test("renders tag pills for each critique", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain(">bug<");
    expect(html).toContain(">style<");
    expect(html).toContain(">lint<");
  });

  test("renders critique text (bubble_short via CritiqueAuditCard)", () => {
    // T11c: text is surfaced as bubble_short inside CritiqueAuditCard.
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain("missing await on db query");
    expect(html).toContain("name reads like a function but returns a class");
    expect(html).toContain("this lint disable is masking a real Number...");
  });

  test("renders file path and line number (CritiqueAuditCard file:line format)", () => {
    // T11c: file+line rendered as "file:line" evidence item inside CritiqueAuditCard.
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain("src/critic.tsx");
    expect(html).toContain(":88");
    expect(html).toContain("shared/memory.ts");
    expect(html).toContain(":120");
  });

  test("renders file path in evidence item (T11c: new card format replaces · LN)", () => {
    // T11c: old '· L88' format is replaced by CritiqueAuditCard's evidence item.
    // The card renders file:line as the evidence location, not the old '· LN' format.
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain("src/critic.tsx:88");
  });

  test("renders data-critique-id attribute on each row", () => {
    const html = String(<CritiqueInbox critiques={MOCK_CRITIQUES} pendingCount={7} />);
    expect(html).toContain('data-critique-id="crit-001"');
    expect(html).toContain('data-critique-id="crit-002"');
    expect(html).toContain('data-critique-id="crit-003"');
  });

  test("empty critiques renders 'no critiques' placeholder", () => {
    const html = String(<CritiqueInbox critiques={[]} pendingCount={0} />);
    expect(html).toContain("no critiques");
    expect((html.match(/class="critique-row"/g) ?? []).length).toBe(0);
  });

  test("design tag renders correct color style", () => {
    const design: Critique = {
      id: "c-design",
      tag: "design",
      text: "layout overflow on mobile",
      file: "ui/home.tsx",
      line: 55,
      ts: "2026-05-18T11:00:00Z",
    };
    const html = String(<CritiqueInbox critiques={[design]} pendingCount={1} />);
    expect(html).toContain(">design<");
  });

  test("pending count 0 renders '0 pending' in pill", () => {
    const html = String(<CritiqueInbox critiques={[]} pendingCount={0} />);
    expect(html).toContain("0 pending");
  });
});
