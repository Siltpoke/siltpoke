// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [58] (audit §61 / §77): a HARD_SUPPRESS row that means "the review did
 * not run because something broke" must parse as an error row (selectable by
 * the errors facet), while a deliberate skip keeps parsing as a fired row.
 */
import { expect, test } from "bun:test";
import { parseCall } from "../../src/state/critic-event-log-parse";

const hardSuppress = (reason: string, extra: Record<string, unknown> = {}) => ({
  timestamp: "2026-10-01T19:26:30.000Z",
  session_id: "sess-hs",
  cwd: "/repo/proj",
  m112_path: true,
  critic_path_decision: "HARD_SUPPRESS",
  m112_reason: reason,
  ...extra,
});

test("legacy HARD_SUPPRESS Brain failure (m112_reason only) parses as brain_error", () => {
  for (const reason of [
    "Brain call failed in NORMAL: BrainError: claude -p timed out after 271s",
    "Brain call failed in PASSIVE_BUBBLE: BrainError: spawn error",
    "runTools threw unexpectedly: Error: boom",
  ]) {
    const call = parseCall(hardSuppress(reason));
    expect(call!.status).toBe("skipped");
    expect(call!.skip_reason).toBe("brain_error");
    expect(call!.error_message).toBe(reason);
  }
});

test("new-shape failure row (error_message stamped by the writer) parses as brain_error", () => {
  const call = parseCall(
    hardSuppress("Brain call failed in NORMAL: x", { error_message: "Brain call failed in NORMAL: x" }),
  );
  expect(call!.skip_reason).toBe("brain_error");
  expect(call!.error_message).toBe("Brain call failed in NORMAL: x");
});

test("negative: a failure-reason row that carries a review body stays a fired row (audit block explains it)", () => {
  const call = parseCall(
    hardSuppress("Brain call failed in NORMAL: x", { brain_output: { bubble_short: "hi", severity: "info" } }),
  );
  expect(call!.status).toBe("fired");
  expect(call!.error_message).toBeNull();
});

test("negative: deliberate HARD_SUPPRESS skips are NOT turned into errors", () => {
  for (const reason of [
    "no tools produced usable output — abstaining",
    "all tools clean, no diff hunks",
    "defensive suppression — no actionable signal identified",
  ]) {
    const call = parseCall(hardSuppress(reason));
    expect(call!.status).toBe("fired");
    expect(call!.error_message).toBeNull();
    expect(call!.skip_reason).toBeNull();
  }
});
