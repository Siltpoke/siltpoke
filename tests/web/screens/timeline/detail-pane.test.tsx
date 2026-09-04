/** @jsxImportSource hono/jsx */
/**
 * detail-pane.test.tsx — render tests for the Timeline detail pane's
 * "chat about this review" trigger (task 5).
 *
 * The button is a plain server-rendered `<button data-siltpoke-critique-chat>`
 * carrying `data-critique-id` + `data-proj-hash` (proj_hash computed
 * SERVER-SIDE by the route, passed in as the `projHash` prop — see
 * src/web/routes/timeline.tsx). It must render ONLY when the row has a
 * critique_id (a plain "skipped" row has none — nothing to discuss).
 */
import { describe, expect, test } from "bun:test";
import type { CriticCall } from "../../../../src/state/critic-event-log";
import { DetailPane } from "../../../../src/web/screens/timeline/detail-pane";
import { AUDIT_ABSENCE_COPY } from "../../../../src/state/audit-absence";

const BASE_CALL: CriticCall = {
  timestamp: "2026-07-12T00:00:00.000Z",
  session_id: "sess-test",
  cwd: "/tmp/project",
  project: "project",
  status: "fired",
  skip_reason: null,
  critique_id: null,
  bubble_short: "watch the auth check",
  bubble_long: null,
  critique_for_claude: "The token expiry uses `<` not `<=`.",
  severity: "high",
  confidence: "high",
  evidence: [],
  audit_absence: "unrecorded" as const,
  evidence_label: null,
  evidence_unverified: 0,
  diff_shown: null,
  diff_total: null,
  gating_decision: null,
  turns_included: null,
  duration_ms: 3200,
  cost_usd: 0.0032,
  tokens: null,
  diff_snapshot_id: null,
  diff_text: null,
  diff_summary: null,
  summary_error: null,
  error_message: null,
  user_action: null,
  speech_kind: "critical",
  reasoning: "Off-by-one on the boundary lets an expired token through.",
  timing: null,
  v2: null,
  provider: "claude",
  authorFamily: "claude",
  billing: "usd",
  model: null,
  branch: null,
  user_raw_query: null,
  user_raw_query_truncated: false,
  agent_reply: null,
};

function fakeCriticCall(overrides: Partial<CriticCall> = {}): CriticCall {
  return { ...BASE_CALL, ...overrides };
}

const NOW = new Date("2026-07-12T00:05:00.000Z");

describe("DetailPane — builder-family provenance tag (Slice B T5)", () => {
  function render(overrides: Partial<CriticCall>): string {
    return String(
      <DetailPane
        c={fakeCriticCall(overrides)}
        now={NOW}
        homeBasename={null}
        preferenceStats={null}
        initial={true}
        projHash="p"
      />,
    );
  }

  test("shows which CLI built the run (authorFamily)", () => {
    expect(render({ authorFamily: "codebuddy" })).toContain("codebuddy");
  });

  test("when the reviewer differs from the builder, shows BOTH (cross-family provenance)", () => {
    const html = render({ authorFamily: "codebuddy", provider: "codex" });
    expect(html).toContain("codebuddy"); // built by
    expect(html).toContain("codex"); // reviewed by
  });
});

describe("DetailPane — the headline is the user's question", () => {
  function render(overrides: Partial<CriticCall>): string {
    return String(
      <DetailPane
        c={fakeCriticCall(overrides)}
        now={NOW}
        homeBasename={null}
        preferenceStats={null}
        initial={true}
        projHash="p"
      />,
    );
  }

  // `headlineFor` used to key on `c.v2?.user_raw_query` alone. The sidecar
  // exists on 4.8% of fired rows, so on nearly every entry the dossier was
  // headlined with the pet's bubble text instead of what was asked. The row
  // fallback fixed that and nothing watched it — deleting it turned no test
  // red, which is how a fix becomes a regression later.
  test("falls back to the ROW's user_raw_query when there is no sidecar", () => {
    const html = render({
      v2: null,
      user_raw_query: "why does the checklist vanish",
      bubble_short: "watch the auth check",
    });
    expect(html).toContain("why does the checklist vanish");
  });

  test("still headlines the bubble when no question was recorded anywhere", () => {
    // Swap-proof: without this, a mutation making the fallback unconditional
    // (always the query, never the bubble) would still pass the test above.
    const html = render({ v2: null, user_raw_query: null, bubble_short: "watch the auth check" });
    expect(html).toContain("watch the auth check");
  });
});

describe("DetailPane — chat about this review trigger", () => {
  test("renders a 'chat about this review' button with critique_id + proj_hash", () => {
    const html = String(
      <DetailPane
        c={fakeCriticCall({ critique_id: "c-1a2b" })}
        now={NOW}
        homeBasename={null}
        preferenceStats={null}
        initial={true}
        projHash="abc123abc123"
      />,
    );
    expect(html).toContain("data-siltpoke-critique-chat");
    expect(html).toContain('data-critique-id="c-1a2b"');
    expect(html).toContain('data-proj-hash="abc123abc123"');
  });

  test("omits the chat button when critique_id is null (a plain skip row)", () => {
    const html = String(
      <DetailPane
        c={fakeCriticCall({ critique_id: null })}
        now={NOW}
        homeBasename={null}
        preferenceStats={null}
        initial={true}
        projHash="abc123abc123"
      />,
    );
    expect(html).not.toContain("data-siltpoke-critique-chat");
  });
});

describe("DetailPane — the unconfirmed mark on the review", () => {
  function renderPane(over: Partial<CriticCall>): string {
    return String(
      <DetailPane
        c={fakeCriticCall(over)}
        now={NOW}
        homeBasename={null}
        preferenceStats={null}
        initial={true}
        projHash="abc123abc123"
      />,
    );
  }

  test("a review with dropped citations is marked, and the mark sits BEFORE the review text", () => {
    const html = renderPane({
      critique_id: "c-unv",
      // Keyed on `evidence_label`, NOT `audit_absence` — the mark asks "how far
      // can I trust this review", and `audit_absence` answers "why is the audit
      // trail missing". A first draft folded the two and would have printed
      // this caveat inside an empty rubric block.
      evidence_label: "partly_unverified",
      evidence_unverified: 2,
      diff_shown: null,
      diff_total: null,
    });
    expect(html).toContain('data-evidence-mark="partly_unverified"');
    expect(html).toContain("2 quotes");
    // Order is the point, not mere presence: a caveat printed under the review
    // is a caveat the reader reaches after already believing it.
    const markAt = html.indexOf("data-evidence-mark");
    const reviewAt = html.indexOf("The token expiry uses");
    expect(markAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(reviewAt);
  });

  test("a review shown only part of the diff says so, above the review", () => {
    // The component's own tests cannot see whether it was ever wired into a
    // surface — that is the gap this one closes. Ordering is asserted for the
    // same reason as the evidence mark above: a caveat printed under the review
    // is a caveat the reader reaches after already believing it.
    const html = renderPane({
      evidence_label: "verified",
      evidence_unverified: 0,
      diff_shown: 20,
      diff_total: 91,
    });
    expect(html).toContain('data-partial-diff="true"');
    expect(html).toContain('data-diff-shown="20"');
    expect(html).toContain('data-diff-total="91"');

    const markAt = html.indexOf("data-partial-diff");
    const reviewAt = html.indexOf("The token expiry uses");
    expect(markAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(reviewAt);
  });

  test("a fully-shown review carries no partial-diff mark", () => {
    const html = renderPane({
      evidence_label: "verified",
      evidence_unverified: 0,
      diff_shown: null,
      diff_total: null,
    });
    expect(html).not.toContain("data-partial-diff");
  });

  test("a review whose evidence all checked out carries NO mark", () => {
    const html = renderPane({
      critique_id: "c-ok",
      audit_absence: "present",
      evidence_label: "verified",
      evidence_unverified: 0,
      diff_shown: null,
      diff_total: null,
    });
    expect(html).not.toContain("data-evidence-mark");
    // ...while still rendering the review, so this is not passing on a blank page.
    expect(html).toContain("The token expiry uses");
  });

  test("an empty audit block explains ITSELF, never the dropped citations", () => {
    // The defect an independent reviewer caught in the first draft: the
    // evidence label was folded into `audit_absence`, so a marked review whose
    // v2 sidecar was missing printed "…the quotes that did check out are shown
    // as usual" as the explanation for a blank RUBRIC CHECKLIST. Two questions,
    // two fields — and this asserts they cannot re-merge.
    const html = renderPane({
      critique_id: "c-both",
      audit_absence: "present", // no v2 sidecar → blocks render their placeholder
      evidence_label: "none_verified",
      evidence_unverified: 1,
      diff_shown: null,
      diff_total: null,
    });
    // The mark is on the review...
    expect(html).toContain('data-evidence-mark="none_verified"');
    // ...and the block placeholder is the `present` copy, which says nothing
    // about quotes. Matched on an apostrophe-free fragment: the renderer
    // escapes `'` to `&#39;`, so asserting the whole sentence fails for a
    // reason unrelated to what is under test. The second assertion keeps the
    // fragment honest — if the copy is reworded, this goes red rather than
    // quietly checking a string that no longer appears in it.
    const PRESENT_FRAGMENT = "this part is only recorded on some runs";
    expect(AUDIT_ABSENCE_COPY.present).toContain(PRESENT_FRAGMENT);
    expect(html).toContain(PRESENT_FRAGMENT);

    // Scoped to the block, NOT to the page. A page-level
    // `not.toContain("could not be found")` would fail here for the wrong
    // reason — the MARK says exactly that, a few hundred bytes higher up, and
    // it is supposed to. What must not happen is the audit block borrowing it.
    const blockC = html.slice(html.indexOf('data-audit-block="C"'));
    const blockCEnd = blockC.indexOf('data-audit-block="D"');
    const blockCOnly = blockCEnd > 0 ? blockC.slice(0, blockCEnd) : blockC;
    expect(blockCOnly).toContain("RUBRIC CHECKLIST"); // sliced the right region
    expect(blockCOnly).not.toContain("could not be found");
    expect(blockCOnly).not.toContain("quote");
  });
});
