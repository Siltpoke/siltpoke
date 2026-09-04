/**
 * /timeline detail-pane tabs (Diff / Trace / Feedback) + the Trace-tab SSR
 * fragment endpoint.
 *
 * Split from timeline.test.ts (the shell suites live there) to keep
 * both files under the 400-LOC ratchet. Shared brain-calls.jsonl + trace
 * seeding helpers live in ./timeline-fixtures.
 *
 *   Diff tab: haiku summary inline; per-file diff on demand (bodies
 *         never embedded); honest notes for GC'd / never-snapshotted turns.
 *   Trace tab: on-demand SSR fragment from
 *         GET /api/critique/:id/trace (waterfall + brain-span costs +
 *         cache-savings banner); honest no-trace / no-index / corrupt-index
 *         states, never a 500.
 *   Feedback tab: existing feedback + ack/dismiss affordances wired
 *         to the existing APIs from the new surface.
 */
import { AUDIT_ABSENCE_COPY } from "../../../src/state/audit-absence";
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountTimelineRoutes } from "../../../src/web/routes/timeline";
import {
  DIFF_GONE_NOTE,
  DIFF_NEVER_NOTE,
} from "../../../src/web/screens/timeline/detail-tabs";
import { TRACE_NOTE_COPY } from "../../../src/web/screens/timeline/trace-tab";
import { seedTrace, writeFixture } from "./timeline-fixtures";

let homeBase: string;

beforeEach(async () => {
  homeBase = join(tmpdir(), `timeline-tabs-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountTimelineRoutes(app, { homeBase });
  return app;
}

async function getHtml(path: string): Promise<string> {
  const res = await buildApp().request(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe("Diff tab", () => {
  const summary = {
    intent: "tighten the retry loop around cache writes",
    key_changes: ["wrap writeCache in withTimeout", "add backoff to retry()"],
    risks: ["timeout too aggressive for cold disks"],
    file_count: 1,
    files_with_purpose: [{ path: "src/cache.ts", purpose: "retry wrapper" }],
    source: "haiku" as const,
  };

  test("haiku structured summary renders inline (no fetch needed)", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        critique_id: "cq-diff-1",
        diff_snapshot_id: "snap-1.diff",
        diff_summary: summary,
      },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("diff summary · haiku pre-pass");
    expect(html).toContain("tighten the retry loop around cache writes");
    expect(html).toContain("wrap writeCache in withTimeout");
    expect(html).toContain("timeout too aggressive for cold disks");
    expect(html).toContain("src/cache.ts");
  });

  test("per-file diff loads on demand: loader targets the existing diff endpoint, gated on tab+selection", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        critique_id: "cq-diff-2",
        diff_snapshot_id: "snap-2.diff",
        diff_summary: summary,
      },
    ]);
    const html = await getHtml("/timeline");
    // On-demand mechanism (mirrors /history's row-expansion loader).
    expect(html).toContain("/api/critique/cq-diff-2/diff");
    expect(html).toContain("load_diff()");
    // The x-effect gate loads only when THIS pane is selected AND the Diff
    // tab is open — a tab click must not fan out one fetch per pane.
    expect(html).toContain(
      "if (tab === &quot;diff&quot; &amp;&amp; selected === &quot;2026-07-01T10:00:00Z|s1&quot;) load_diff()",
    );
    // 404 contingency markup ships with the pane: honest GC'd-snapshot note.
    expect(html).toContain(DIFF_GONE_NOTE);
  });

  test("diff bodies stay OUT of the page even when the snapshot exists on disk", async () => {
    const snapshotId = "snap.diff";
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        critique_id: "cq-with-diff",
        diff_snapshot_id: snapshotId,
        diff_summary: summary,
      },
    ]);
    const snapDir = join(homeBase, "critic-snapshots");
    await mkdir(snapDir, { recursive: true });
    await writeFile(
      join(snapDir, snapshotId),
      "diff --git a/src/x.ts b/src/x.ts\n+SECRET_DIFF_BODY_MARKER\n",
      "utf8",
    );
    const html = await getHtml("/timeline");
    expect(html).not.toContain("SECRET_DIFF_BODY_MARKER");
  });

  test("turn without a snapshot: honest never-snapshotted note + no summary note, no loader", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain(DIFF_NEVER_NOTE);
    expect(html).toContain("no haiku summary for this turn");
    expect(html).not.toContain("load_diff()");
  });
});

describe("Trace tab fragment endpoint", () => {
  test("seeded critique+spans: span timeline + brain-span costs + cache banner", async () => {
    const traceId = "f00d0000000000000000000000000001";
    await seedTrace(homeBase, "cq-traced", traceId);
    const res = await buildApp().request("/api/critique/cq-traced/trace");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Join resolved: the fragment carries the linked trace.
    expect(html).toContain(`data-trace-id="${traceId}"`);
    expect(html).toContain(`/traces/${traceId}`);
    // Per-brain-span cost breakdown.
    expect(html).toContain("Brain call cost breakdown (1 call)");
    expect(html).toContain("siltpoke.brain.find");
    expect(html).toContain("1.0k"); // input tokens
    // Cache banner (design copy): saved / would have cost / actual + right
    // side hit-rate. input_tokens is EXCLUSIVE of cache reads (claude -p
    // semantics): 400 cached of a 1400-token prompt = 29%.
    expect(html).toContain("data-cache-banner");
    expect(html).toContain("saved");
    expect(html).toContain("would have cost");
    expect(html).toContain("actual");
    expect(html).toContain("29% · 400 cached");
    // The flat waterfall section is replaced by the merged span timeline.
    expect(html).not.toContain("Phase timing waterfall");
    expect(html).toContain("Span timeline · click to expand");
  });

  test("cache banner renders honest zeros when brain calls exist but usage was never recorded (live-smoke bug)", async () => {
    // Live `siltpoke.brain.*` spans carry no gen_ai.usage attrs (claude -p
    // subprocess) → totals are all zero. The old `cost_usd <= 0` guard hid
    // the banner; it must render zeros honestly whenever brain calls exist.
    const traceId = "f00d0000000000000000000000000009";
    await seedTrace(homeBase, "cq-zero", traceId, { usage: false, kinds: false });
    const html = await (await buildApp().request("/api/critique/cq-zero/trace")).text();
    expect(html).toContain("Brain call cost breakdown (1 call)");
    expect(html).toContain("data-cache-banner");
    expect(html).toContain("saved");
    expect(html).toContain("$0.00");
    // No input tokens → hit-rate is an honest dash, not a fake 0%.
    expect(html).toMatch(/data-cache-hit[^>]*>—</);
    // Spans without a siltpoke.kind attribute get NO kind tag.
    expect(html).not.toContain("data-kind=");
  });

  test("span timeline: kind tags + tree indentation; rows are in-page <details>, not nav links", async () => {
    const traceId = "f00d0000000000000000000000000001";
    await seedTrace(homeBase, "cq-traced", traceId);
    const html = await (await buildApp().request("/api/critique/cq-traced/trace")).text();
    // Kind tags from the spans' siltpoke.kind attributes.
    expect(html).toContain('data-kind="chain"');
    expect(html).toContain('data-kind="llm"');
    // Child span (brain.find under turn) indented one tree level.
    expect(html).toContain("padding-left:15px");
    // Design fixup (2nd smoke): a span row is a <details>/<summary> that
    // expands an inline panel IN the page — NOT an <a> that navigates away.
    expect(html).toContain('<details class="tl-span-details"');
    expect(html).toContain('<summary class="tl-span-row"');
    expect(html).not.toContain('<a class="tl-span-row"');
    // The explorer deep-link survives as a small secondary link INSIDE the
    // expanded panel (one per span).
    expect(html).toContain('class="tl-span-explorer-link"');
    expect(html).toContain(`/traces/${traceId}?span=aaaa000000000001`);
    expect(html).toContain(`/traces/${traceId}?span=aaaa000000000002`);
    // Short names (siltpoke. prefix stripped) in the timeline rows.
    expect(html).toContain(">brain.find<");
  });

  test("expanded span panel: Metadata KV rows (data-bearing rows only; no header — the summary row above already carries name/kind/lat)", async () => {
    const traceId = "f00d0000000000000000000000000001";
    await seedTrace(homeBase, "cq-traced", traceId);
    const html = await (await buildApp().request("/api/critique/cq-traced/trace")).text();
    // Metadata tab KV rows for the brain (llm) span.
    expect(html).toContain(">span_id<");
    expect(html).toContain(">aaaa000000000002<");
    expect(html).toContain(">parent_span_id<");
    // Root span's parent renders as "(root)".
    expect(html).toContain(">(root)<");
    expect(html).toContain(">span.kind<");
    expect(html).toContain(">status<");
    expect(html).toContain(">latency<");
    expect(html).toContain(">llm.model<");
    expect(html).toContain(">claude-haiku-4-5<");
    expect(html).toContain(">tokens.input<");
    expect(html).toContain(">tokens.output<");
    // tokens.cached row carries the hit % (400 of the 1400-token prompt = 29%;
    // input_tokens excludes cache reads).
    expect(html).toContain(">tokens.cached<");
    expect(html).toContain("400 (29%)");
    expect(html).toContain(">cost.usd<");
    // No siltpoke.repo / siltpoke.cwd attr on these spans → rows omitted.
    expect(html).not.toContain(">siltpoke.repo<");
    expect(html).not.toContain(">siltpoke.cwd<");
  });

  test("panel tabs are CSS-only radios (x-html constraint: no Alpine, no script)", async () => {
    const traceId = "f00d0000000000000000000000000001";
    await seedTrace(homeBase, "cq-traced", traceId);
    const html = await (await buildApp().request("/api/critique/cq-traced/trace")).text();
    // Radio-input tab mechanism; Metadata + Raw always available.
    expect(html).toContain('type="radio"');
    expect(html).toContain("tl-rtab-meta");
    expect(html).toContain("tl-rtab-raw");
    expect(html).toContain(">Metadata<");
    expect(html).toContain(">Raw<");
    // Seeded spans carry no siltpoke.input/output → no Messages tab.
    expect(html).not.toContain(">Messages<");
    // Metadata is the default-checked tab when there is no io.
    expect(html).toMatch(/<input[^>]*tl-rtab-meta[^>]*checked/);
    // x-html constraint: the fragment must be Alpine-free and script-free.
    expect(html).not.toContain("x-on:");
    expect(html).not.toContain("x-data");
    expect(html).not.toContain("<script");
  });

  test("span with recorded io: Messages tab present, default-checked, shows input/output", async () => {
    const traceId = "f00d0000000000000000000000000003";
    await seedTrace(homeBase, "cq-io", traceId, { io: true });
    const html = await (await buildApp().request("/api/critique/cq-io/trace")).text();
    expect(html).toContain(">Messages<");
    expect(html).toMatch(/<input[^>]*tl-rtab-msg[^>]*checked/);
    // The recorded siltpoke.input / siltpoke.output attribute bodies render.
    expect(html).toContain("fixture prompt for the brain");
    expect(html).toContain("fixture brain verdict");
  });

  test("hostile io payload is escaped (x-html sink) and display-capped at 2000 chars", async () => {
    // The fragment lands in the page via Alpine x-html — attribute payloads
    // are attacker-influenced (whatever the traced code sent the brain), so
    // markup in them must arrive entity-escaped, never as live tags.
    const traceId = "f00d0000000000000000000000000004";
    const hostile = '<script>alert("pwn")</script><img src=x onerror=alert(1)> & "broken';
    await seedTrace(homeBase, "cq-hostile", traceId, {
      io: { input: hostile, output: `${"A".repeat(2500)}IO_TAIL_MARKER` },
    });
    const html = await (await buildApp().request("/api/critique/cq-hostile/trace")).text();
    // No live tags anywhere in the fragment (Messages pane OR Raw pane).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    // The payload text survives, entity-escaped — tags, quotes, ampersand.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("alert(&quot;pwn&quot;)");
    expect(html).toContain("&amp; &quot;broken");
    // Messages pane display cap (same 2000-char cap as MessagesView): the
    // 2500-char output is cut before its tail, so the tail marker appears
    // exactly ONCE — in the Raw pane's full JSON record, not in Messages.
    expect(html).toContain("… [truncated]");
    expect(html.split("IO_TAIL_MARKER").length - 1).toBe(1);
  });

  test("span timeline: duration+count header and TOK / LAT cells", async () => {
    const traceId = "f00d0000000000000000000000000001";
    await seedTrace(homeBase, "cq-traced", traceId);
    const html = await (await buildApp().request("/api/critique/cq-traced/trace")).text();
    // Section header right side: <total_duration> · <N> spans.
    expect(html).toContain("2.0s · 2 spans");
    // TOK: brain span 1000+500 → "1.5k"; root span has no tokens → "·".
    expect(html).toContain(">1.5k<");
    expect(html).toContain(">·<");
    // LAT: brain 1500ms → "1.5s", root 2000ms → "2.0s".
    expect(html).toContain(">1.5s<");
    expect(html).toContain(">2.0s<");
  });

  test("critique with no linked spans: honest no-trace note, 200", async () => {
    await seedTrace(homeBase, "cq-other", "f00d0000000000000000000000000002");
    const res = await buildApp().request("/api/critique/cq-unlinked/trace");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(TRACE_NOTE_COPY["no-trace"]);
  });

  test("no sqlite index at all: honest no-index note, never 500", async () => {
    const res = await buildApp().request("/api/critique/cq-anything/trace");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-trace-note="no-index"');
  });

  test("corrupt index file: honest index-error note, never 500", async () => {
    await mkdir(join(homeBase, "traces"), { recursive: true });
    await writeFile(join(homeBase, "traces", "index.sqlite"), "this is not sqlite", "utf8");
    const res = await buildApp().request("/api/critique/cq-anything/trace");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-trace-note="index-error"');
  });

  test("invalid critique_id rejected", async () => {
    const res = await buildApp().request("/api/critique/not(valid)/trace");
    expect(res.status).toBe(400);
  });
});

describe("Trace tab client shell", () => {
  test("turn with critique_id carries the on-demand loader for the fragment endpoint", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", critique_id: "cq-traced" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("/api/critique/cq-traced/trace");
    expect(html).toContain("load_trace()");
    expect(html).toContain(
      "if (tab === &quot;trace&quot; &amp;&amp; selected === &quot;2026-07-01T10:00:00Z|s1&quot;) load_trace()",
    );
    // No trace data embedded in the page itself.
    expect(html).not.toContain("Brain call cost breakdown");
  });

  // Read the legacy sentence off the copy map rather than re-typing it. A
  // hardcoded literal here was already wrong once: the first draft asserted
  // "pre-dates pipeline wire", a string this change deletes outright, so the
  // test failed against copy that was working correctly. Sourcing it means the
  // property under test — "the legacy wording appears on the legacy row and
  // nowhere else" — survives any rewording of the copy itself.
  const LEGACY_CLAIM = AUDIT_ABSENCE_COPY.unrecorded;

  test("turn without critique_id and without a recorded reason: says so, no loader", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain('data-trace-note="no-critique-id"');
    expect(html).toContain('data-absence="unrecorded"');
    expect(html).not.toContain("load_trace()");
    // This row genuinely has nothing recorded, so the legacy wording is correct
    // HERE and only here.
    expect(html).toContain(LEGACY_CLAIM);
  });

  /**
   * The regression that matters, pinned at the ROUTE level rather than only on
   * the component. Before this change every absence rendered the same "this
   * review pre-dates pipeline wire OR ran on legacy path" — on reviews minutes
   * old — while the accurate reason sat unread on the same row in
   * `m112_guard_reason`. The component tests assert a substring is present; only
   * a route render proves the reason travels from the JSONL row to the page.
   */
  test("turn whose guard reason IS recorded shows that reason, never the legacy claim", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        guard_reason: "NORMAL mode but evidence array empty",
      },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain('data-absence="evidence_empty"');
    expect(html).toContain(AUDIT_ABSENCE_COPY.evidence_empty);
    expect(html).not.toContain(LEGACY_CLAIM);
  });

  /**
   * Pull the Trace tab's OWN note text out of the page.
   *
   * This exists because a mutation exposed a hole: reverting the Trace tab to
   * its old fixed sentence turned NOTHING red. The assertions above matched the
   * same reason text rendered by audit blocks A/C/D elsewhere on the page, so
   * the Trace branch had no coverage of its own at all — a check that cannot
   * fail for the thing it is named after.
   */
  function traceNoteText(html: string): string {
    const m = /data-trace-note="no-critique-id"[^>]*>([^<]*)</.exec(html);
    return m?.[1]?.trim() ?? "";
  }

  test("the Trace tab's OWN note carries the row's reason, not a fixed sentence", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        guard_reason: "NORMAL mode but evidence array empty",
      },
    ]);
    const note = traceNoteText(await getHtml("/timeline"));
    expect(note).toBe(AUDIT_ABSENCE_COPY.evidence_empty);
  });

  test("the Trace tab's note changes with the row — not the same string every time", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        suppress_reason:
          "Brain call failed in NORMAL: BrainError: [brain-failure class=resource attempts=1] claude -p exited with code 143: ",
      },
    ]);
    const note = traceNoteText(await getHtml("/timeline"));
    expect(note).toBe(AUDIT_ABSENCE_COPY.brain_killed);
    // The pair is the point: one row alone cannot distinguish "reads the row"
    // from "prints a constant that happens to match".
    expect(note).not.toBe(AUDIT_ABSENCE_COPY.evidence_empty);
  });

  test("a suppressed turn reports the suppression, not a guard rejection", async () => {
    await writeFixture(homeBase, [
      {
        ts: "2026-07-01T10:00:00Z",
        session: "s1",
        status: "fired",
        suppress_reason:
          "Brain call failed in NORMAL: BrainError: [brain-failure class=resource attempts=1] claude -p exited with code 143: ",
      },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain('data-absence="brain_killed"');
    expect(html).toContain(AUDIT_ABSENCE_COPY.brain_killed);
    expect(html).not.toContain(LEGACY_CLAIM);
  });
});

describe("Feedback tab", () => {
  test("feedback box wired to the existing per-critique feedback API", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", critique_id: "cq-fb" },
    ]);
    const html = await getHtml("/timeline");
    // FeedbackSection composed as-is: GET+POST /api/critique/:id/feedback.
    expect(html).toContain("/api/critique/cq-fb/feedback");
    expect(html).toContain('data-feedback-textarea="cq-fb"');
    expect(html).toContain("feedback · your note (saved to siltpoke memory)");
  });

  test("ack/dismiss (RowActions) write through the existing /api/critic/action", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", critique_id: "cq-fb" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("/api/critic/action");
    expect(html).toContain("critic-row-action-ack");
    expect(html).toContain("critic-row-action-dismiss");
  });

  test("legacy fired turn without critique_id still gets a synthetic feedback key", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("/api/critique/legacy-s1-2026-07-01T10-00-00Z/feedback");
  });

  test("FeedbackSection lazy-mounts behind a per-pane latched template — no load() fan-out at page load", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", critique_id: "cq-a" },
      { ts: "2026-07-01T11:00:00Z", session: "s2", status: "fired", critique_id: "cq-b" },
    ]);
    const html = await getHtml("/timeline");
    // Under the lazy-dossier page, only the PRE-SELECTED pane (newest = s2)
    // ships its DetailPane eagerly, so exactly ONE FeedbackSection template +
    // loader is present at page load — the other pane is a placeholder whose
    // Feedback tab arrives only when its dossier is morph-loaded.
    const templates = html.match(/<template x-if="fbMounted">/g) ?? [];
    const loaders = html.match(/x-init="load\(\)"/g) ?? [];
    expect(templates.length).toBe(1);
    expect(loaders.length).toBe(1);
    // The eager pane (s2) carries its per-pane latch gate…
    expect(html).toContain(
      "if (tab === &quot;feedback&quot; &amp;&amp; selected === &quot;2026-07-01T11:00:00Z|s2&quot;) fbMounted = true",
    );
    // …the lazy pane (s1) carries NO eager feedback gate — it is a dossier
    // placeholder that hx-gets its DetailPane (gate included) on first select.
    expect(html).not.toContain(
      "if (tab === &quot;feedback&quot; &amp;&amp; selected === &quot;2026-07-01T10:00:00Z|s1&quot;) fbMounted = true",
    );
    expect(html).toContain(
      'hx-get="/api/timeline/dossier?key=2026-07-01T10%3A00%3A00Z%7Cs1"',
    );
  });

  test("RowActions feedback snapshot is gated on the textarea being mounted (ta &&) — unopened tab can't clear a note", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", critique_id: "cq-a" },
    ]);
    const html = await getHtml("/timeline");
    expect(html).toContain("if(cid &amp;&amp; ta &amp;&amp; (");
  });
});
