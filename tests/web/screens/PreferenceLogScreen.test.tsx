/** @jsxImportSource hono/jsx */
/**
 * PreferenceLogScreen smoke tests
 */
import { test, expect, describe } from "bun:test";
import { PreferenceLogScreen } from "../../../src/web/screens/PreferenceLogScreen";
import type { PreferenceLogEntry } from "../../../src/preference-log/types";

const EMPTY_COUNTS = { ack: 0, dismiss: 0, forward: 0, feedback: 0 };

const MOCK_ENTRIES: PreferenceLogEntry[] = [
  {
    ts: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    critique_id: "c-abc123",
    signal: "dismiss",
    reason_text: "too noisy",
    critique_snapshot: {},
    diff_snapshot_sha: null,
    intent_at_critique: null,
    reflexion_rule_fired: null,
  },
  {
    ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    critique_id: "c-def456",
    signal: "ack",
    reason_text: null,
    critique_snapshot: {},
    diff_snapshot_sha: null,
    intent_at_critique: null,
    reflexion_rule_fired: null,
  },
];

describe("PreferenceLogScreen", () => {
  test("renders Dashboard shell", () => {
    const html = String(<PreferenceLogScreen entries={[]} counts={EMPTY_COUNTS} />);
    expect(html).toContain("data-sidebar");
    expect(html).toContain("WORK");
  });

  test("renders Signal Feed header", () => {
    const html = String(<PreferenceLogScreen entries={[]} counts={EMPTY_COUNTS} />);
    expect(html).toContain("Signal Feed");
    expect(html).toContain("PREFERENCE LOG");
  });

  test("shows empty state when no entries", () => {
    const html = String(<PreferenceLogScreen entries={[]} counts={EMPTY_COUNTS} />);
    expect(html).toContain("No preference signals yet");
  });

  test("renders entries with signal badges and critique links", () => {
    const counts = { ack: 1, dismiss: 1, forward: 0, feedback: 0 };
    const html = String(<PreferenceLogScreen entries={MOCK_ENTRIES} counts={counts} />);
    expect(html).toContain("c-abc123");
    expect(html).toContain("c-def456");
    expect(html).toContain("dismiss");
    expect(html).toContain("ack");
  });

  test("shows reason text or dash", () => {
    const counts = { ack: 1, dismiss: 1, forward: 0, feedback: 0 };
    const html = String(<PreferenceLogScreen entries={MOCK_ENTRIES} counts={counts} />);
    expect(html).toContain("too noisy");
    expect(html).toContain("—");
  });

  test.skip("activeSection is preference-log", () => {
    const html = String(<PreferenceLogScreen entries={[]} counts={EMPTY_COUNTS} />);
    expect(html).toContain('href="/preference-log"');
  });
});
