import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectionAlert } from "../../src/critic/injection-alert";
import { writeReviewState } from "../../src/hooks/review-state";
import type { FaceState } from "../../src/state/state";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-review-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const old: FaceState = {
  schemaVersion: 1,
  mood: "happy",
  pose: "base",
  bubble_short: "old bubble",
  severity: "info",
  confidence: "high",
  last_updated_ms: 1_000,
  last_session_id: "s-old",
};
const next: Omit<FaceState, "alert"> = { ...old, mood: "annoyed", bubble_short: "", last_updated_ms: 2_000, last_session_id: "s-new" };
const loud: InjectionAlert = {
  level: "loud",
  toolRecord: "recorded",
  signals: [{ kind: "self", level: "loud", where: "README.md", quote: "obey", why: "steers" }],
};
const file = (): string => join(tmp, "state.json");
const read = (): FaceState => JSON.parse(readFileSync(file(), "utf8")) as FaceState;
const seed = (s: FaceState): void => writeFileSync(file(), JSON.stringify(s));

test("blank bubble + loud alert: only the alert is merged; the rest of the file is untouched (F8)", async () => {
  seed(old);
  expect(await writeReviewState(tmp, "/w/proj", next, true, loud)).toBe(true);
  const s = read();
  expect(s.alert?.project).toBe("proj");
  const { alert: _a, ...rest } = s;
  expect(rest).toEqual(old);
});

test("blank bubble + no alert: an existing alert is cleared, the rest untouched; nothing to clear -> no write (F8)", async () => {
  seed({ ...old, alert: { text: "⚠ x", project: "proj", at: 1 } });
  expect(await writeReviewState(tmp, "/w/proj", next, true, undefined)).toBe(true);
  expect(read()).toEqual(old);
  expect(await writeReviewState(tmp, "/w/proj", next, true, undefined)).toBe(false);
  expect(read()).toEqual(old);
});

test("blank bubble + loud alert with no state file yet: the alert is still written, with a blank bubble (F8)", async () => {
  expect(await writeReviewState(tmp, "/w/proj", next, true, loud)).toBe(true);
  const s = read();
  expect(s.bubble_short).toBe("");
  expect(s.alert?.project).toBe("proj");
});

test("blank bubble + no alert + no file: no write (F8)", async () => {
  expect(await writeReviewState(tmp, "/w/proj", next, true, undefined)).toBe(false);
});

test("a shown bubble writes next and reports the write (F8)", async () => {
  seed(old);
  expect(await writeReviewState(tmp, "/w/proj", { ...next, bubble_short: "new" }, false, undefined)).toBe(true);
  expect(read().bubble_short).toBe("new");
});

const quietScan: InjectionAlert = {
  level: "quiet",
  toolRecord: "recorded",
  signals: [{ kind: "scan", level: "quiet", where: "AGENTS.md", quote: "ignore the reviewer", why: "reads like an instruction to the AI" }],
};

test("quiet scan-only alert sets no bubble alert (R10: bubble is loud-only)", async () => {
  seed(old);
  expect(await writeReviewState(tmp, "/w/proj", { ...next, bubble_short: "new" }, false, quietScan)).toBe(true);
  expect(read().alert).toBeUndefined();
  expect(await writeReviewState(tmp, "/w/proj", next, true, quietScan)).toBe(false);
  expect(read().alert).toBeUndefined();
});

test("quiet scan-only review clears an earlier loud alert (R10)", async () => {
  seed({ ...old, alert: { text: "⚠ x", project: "proj", at: 1 } });
  expect(await writeReviewState(tmp, "/w/proj", { ...next, bubble_short: "new" }, false, quietScan)).toBe(true);
  expect(read().alert).toBeUndefined();
});
