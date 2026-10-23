// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [58] (audit §61 / §77), assembly level: a HARD_SUPPRESS brain failure
 * is visible under the /timeline errors filter with its reason, is not a
 * normal fired review, and a deliberate no-op suppression stays out as before.
 */
import { beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountTimelineRoutes } from "../../../src/web/routes/timeline";
import { writeFixture } from "./timeline-fixtures";

let homeBase: string;

beforeEach(async () => {
  homeBase = join(tmpdir(), `timeline-hs-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

async function getHtml(path: string): Promise<string> {
  const app = new Hono();
  mountTimelineRoutes(app, { homeBase });
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.text();
}

const hardSuppressLine = (session: string, ts: string, reason: string): string =>
  JSON.stringify({
    timestamp: ts,
    session_id: session,
    cwd: "/Users/foo/projA",
    m112_path: true,
    critic_path_decision: "HARD_SUPPRESS",
    m112_reason: reason,
  });

async function seed(): Promise<void> {
  await writeFixture(homeBase, [
    { ts: "2026-07-01T10:00:00Z", session: "s1", status: "fired", bubble_short: "healthy turn" },
  ]);
  const lines = [
    hardSuppressLine("s-fail", "2026-07-01T11:00:00Z", "Brain call failed in NORMAL: BrainError: claude -p timed out after 271s"),
    hardSuppressLine("s-noop", "2026-07-01T12:00:00Z", "all tools clean, no diff hunks"),
  ];
  await appendFile(join(homeBase, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

test("errors facet lists the failure with its reason; not the no-op, not the healthy turn", async () => {
  await seed();
  const html = await getHtml("/timeline?status=errors");
  expect(html).toContain("1 turn ·");
  expect(html).toContain("Brain call failed in NORMAL");
  expect(html).not.toContain("healthy turn");
  expect(html).not.toContain("all tools clean");
});

test("the clipped rail row carries the full reason in a title attribute", async () => {
  await seed();
  const html = await getHtml("/timeline?status=errors");
  expect(html).toContain(
    'title="brain_error: Brain call failed in NORMAL: BrainError: claude -p timed out after 271s"',
  );
});

test("the failure is not a normal fired review; the no-op row stays out of every facet", async () => {
  await seed();
  const fired = await getHtml("/timeline");
  expect(fired).toContain("healthy turn");
  expect(fired).not.toContain("Brain call failed in NORMAL");
  const all = await getHtml("/timeline?status=all");
  expect(all).toContain("Brain call failed in NORMAL");
  expect(all).toContain("2 turns ·");
  expect(all).not.toContain("all tools clean");
});
