// The injection alert on the pet bubble: it outlasts the 30-minute staleness
// rule, ranks below the stopped-reviewer latch and above a fresh review.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertBubbleText } from "../../src/critic/injection-alert.ts";
import { runWrapper } from "../../src/face/wrapper.ts";

let tempBase: string;
let projectBase: string;

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), "siltpoke-test-"));
  projectBase = mkdtempSync(join(tmpdir(), "siltpoke-proj-"));
});
afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
  rmSync(projectBase, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const alertText = "⚠ Project text tried to steer the review: README.md (proj)";

const writeProjectState = (ageMs: number, extra: Record<string, unknown> = { alert: { text: alertText, project: "proj", at: Date.now() - ageMs } }): void => {
  writeFileSync(
    join(projectBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "happy",
      pose: "base",
      bubble_short: "fresh review words",
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now() - ageMs,
      last_session_id: "p1",
      ...extra,
    }),
  );
};

const run = (): Promise<string> => runWrapper({ basePath: tempBase, projectBase, termWidth: 200 });

test("alert shows when the state is 2 hours old (staleness does not hide it)", async () => {
  writeProjectState(2 * HOUR);
  const out = await run();
  expect(out).toContain(alertText);
  expect(out).not.toContain("fresh review words");
});

test("alert wins over a fresh review bubble", async () => {
  writeProjectState(1000);
  const out = await run();
  expect(out).toContain(alertText);
  expect(out).not.toContain("fresh review words");
});

test("a stale state with no alert still shows no review bubble", async () => {
  writeProjectState(2 * HOUR, {});
  expect(await run()).not.toContain("fresh review words");
});

test("the stopped-reviewer latch still wins over the alert", async () => {
  writeProjectState(1000);
  const opened = new Date(Date.now() - HOUR).toISOString();
  writeFileSync(
    join(tempBase, "brain-health.json"),
    JSON.stringify({
      schema_version: 1,
      last_attempt_ts: opened,
      last_success_ts: null,
      consecutive_failures: 2,
      last_failure: { class: "permanent", exit_code: null, stderr_excerpt: "x", ts: opened },
      breaker: { class: "permanent", opened_at: opened, next_eligible_at: new Date(Date.now() + HOUR).toISOString() },
      retry_budget: { date: "", outer_retries_used: 0 },
    }),
  );
  const out = await run();
  expect(out).toContain("I stopped reviewing");
  expect(out).not.toContain(alertText);
});

test("a hostile `where` renders as one plain line", async () => {
  const text = alertBubbleText(
    { level: "loud", toolRecord: "recorded", signals: [{ kind: "self", level: "loud", where: "\u001b[31mevil\u001b[0m\nsecond line\u0007", quote: "q", why: "w" }] },
    "proj",
  );
  writeProjectState(2 * HOUR, { alert: { text, project: "proj", at: Date.now() } });
  const out = await run();
  expect(out).toContain("evil second line");
  expect(out).not.toContain("\u001b[31mevil");
  expect(out).not.toContain("\u0007");
});
