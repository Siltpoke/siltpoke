/**
 * A blanked (bubble_suppressed) review row that carries an injection alert stays on
 * the timeline (F5) — split from critic-event-log.test.ts, which is at its length pin.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBrainCallsPage, readCriticTelemetry } from "../../src/state/critic-event-log";

let homeBase: string;
const now = new Date("2026-05-19T15:00:00Z");

beforeEach(async () => {
  homeBase = join(tmpdir(), `critic-alert-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

const fired = (ts: string, session: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: ts,
    session_id: session,
    cwd: "/Users/foo/projA",
    brain_output: { bubble_short: "short", bubble_long: null, critique_for_claude: null, severity: "info", confidence: "low", evidence: [] },
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.001 },
    ...extra,
  });

const loud = {
  level: "loud",
  toolRecord: "recorded",
  signals: [{ kind: "tool", level: "loud", where: "/etc/passwd", quote: "/etc/passwd", why: "read outside the project" }],
};

async function seed(): Promise<void> {
  const lines = [
    fired("2026-05-19T14:00:00Z", "alerted", { bubble_suppressed: true, injection_alert: loud }),
    fired("2026-05-19T14:05:00Z", "blank", { bubble_suppressed: true }),
    fired("2026-05-19T14:10:00Z", "shown"),
  ];
  await writeFile(join(homeBase, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

describe("a blanked row that carries an injection alert stays on the timeline (F5)", () => {
  test("parse: the suppressed row parses with no bubble but keeps its alert", async () => {
    await seed();
    const page = await readBrainCallsPage(homeBase, {
      limit: 20,
      rangeCutoff: null,
      anchor: "newest",
      status: "fired",
      kind: null,
      query: null,
      project: null,
    });
    const ids = page.calls.map((c) => c.session_id);
    expect(ids).toContain("alerted");
    expect(ids).not.toContain("blank");
    const row = page.calls.find((c) => c.session_id === "alerted");
    expect(row?.bubble_short).toBeNull();
    expect(row?.injection_alert?.level).toBe("loud");
  });

  test("assembly: the /timeline list model includes the alerted row, not the plain blank one", async () => {
    await seed();
    const t = await readCriticTelemetry(homeBase, now, { windowMode: "turns", limit: 20 });
    const ids = t.recent.map((c) => c.session_id);
    expect(ids).toContain("alerted");
    expect(ids).toContain("shown");
    expect(ids).not.toContain("blank");
  });
});
