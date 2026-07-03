/**
 * Fired rows with empty/missing bubble_short are filtered out
 * of dashboard history at the read/assembly layer (legacy "(no bubble)"
 * rows), and write-side `bubble_suppressed` flags hide the row even when
 * the logged brain_output retains the original bubble text.
 *
 * Split from critic-event-log.test.ts to keep that file under the 400-LOC
 * ratchet.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { readCriticTelemetry } from "../../src/state/critic-event-log";

let homeBase: string;
const now = new Date("2026-05-19T15:00:00Z");

beforeEach(async () => {
  homeBase = join(tmpdir(), `critic-no-bubble-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

interface FixtureCall {
  ts: string;
  session: string;
  status: "fired" | "skipped";
  bubble_short?: string;
}

async function writeFixture(base: string, calls: FixtureCall[]): Promise<void> {
  await mkdir(base, { recursive: true });
  const lines = calls.map((c) => {
    if (c.status === "skipped") {
      return JSON.stringify({
        timestamp: c.ts,
        session_id: c.session,
        cwd: "/Users/foo/projA",
        skipped: "quiet_hours",
      });
    }
    return JSON.stringify({
      timestamp: c.ts,
      session_id: c.session,
      cwd: "/Users/foo/projA",
      brain_output: {
        bubble_short: c.bubble_short ?? "short",
        severity: "info",
        confidence: "low",
        evidence: [],
      },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        total_cost_usd: 0.001,
      },
    });
  });
  await writeFile(join(base, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

describe("no-bubble row filter (read/assembly layer)", () => {
  test("fired row with EMPTY-string bubble_short is filtered from history", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s-empty", status: "fired", bubble_short: "" },
      { ts: "2026-05-19T14:05:00Z", session: "s-real", status: "fired", bubble_short: "real" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.map((c) => c.session_id)).toEqual(["s-real"]);
  });

  test("fired row with MISSING bubble_short field is filtered (the `??` nuance)", async () => {
    await mkdir(homeBase, { recursive: true });
    const missingBubble = JSON.stringify({
      timestamp: "2026-05-19T14:00:00Z",
      session_id: "s-missing",
      cwd: "/Users/foo/projA",
      brain_output: { severity: "info", confidence: "low", evidence: [] },
    });
    const real = JSON.stringify({
      timestamp: "2026-05-19T14:05:00Z",
      session_id: "s-real",
      cwd: "/Users/foo/projA",
      brain_output: { bubble_short: "real", severity: "info", confidence: "high", evidence: [] },
    });
    await writeFile(join(homeBase, "brain-calls.jsonl"), `${missingBubble}\n${real}\n`, "utf8");
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.map((c) => c.session_id)).toEqual(["s-real"]);
  });

  test("fired row flagged bubble_suppressed is filtered even when brain_output kept the original text", async () => {
    await mkdir(homeBase, { recursive: true });
    const suppressed = JSON.stringify({
      timestamp: "2026-05-19T14:00:00Z",
      session_id: "s-suppressed",
      cwd: "/Users/foo/projA",
      bubble_suppressed: true,
      brain_output: { bubble_short: "original low-conf text", severity: "info", confidence: "low", evidence: [] },
    });
    await writeFile(join(homeBase, "brain-calls.jsonl"), `${suppressed}\n`, "utf8");
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.length).toBe(0);
  });

  test("skipped rows are NOT touched by the no-bubble filter", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "skp", status: "skipped" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.status).toBe("skipped");
  });
});
