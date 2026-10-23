import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runActionCli } from "../../src/cli/action";
import { runPet } from "../../src/cli/pet";
import { clearAlert, type FaceState, readState, writeState, writeStateKeepingAlert } from "../../src/state/state";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-state-alert-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const next: Omit<FaceState, "alert"> = {
  schemaVersion: 1,
  mood: "happy",
  pose: "base",
  bubble_short: "hi",
  severity: "info",
  confidence: "high",
  last_updated_ms: 1_000,
  last_session_id: "s",
};
const alert = { text: "⚠ Project text tried to steer the review: README.md (p)", project: "p", at: 5 };

test("a state file without alert still reads", async () => {
  writeFileSync(join(tmp, "state.json"), JSON.stringify({ ...next }));
  const s = await readState(tmp);
  expect(s?.bubble_short).toBe("hi");
  expect(s?.alert).toBeUndefined();
});

test("a malformed alert is dropped, the state still reads", async () => {
  writeFileSync(join(tmp, "state.json"), JSON.stringify({ ...next, alert: { text: 3 } }));
  const s = await readState(tmp);
  expect(s).not.toBeNull();
  expect(s?.alert).toBeUndefined();
});

test("set writes the alert; keep preserves it across a write; clear removes it", async () => {
  await writeStateKeepingAlert(tmp, next, { set: alert });
  expect((await readState(tmp))?.alert).toEqual(alert);
  await writeStateKeepingAlert(tmp, { ...next, bubble_short: "later" }, "keep");
  const kept = await readState(tmp);
  expect(kept?.bubble_short).toBe("later");
  expect(kept?.alert).toEqual(alert);
  await writeStateKeepingAlert(tmp, next, "clear");
  expect((await readState(tmp))?.alert).toBeUndefined();
});

test("keep with no file or no alert writes no alert", async () => {
  await writeStateKeepingAlert(tmp, next, "keep");
  expect((await readState(tmp))?.alert).toBeUndefined();
});

test("clearAlert drops only the alert", async () => {
  await writeStateKeepingAlert(tmp, next, { set: alert });
  await clearAlert(tmp);
  const s = await readState(tmp);
  expect(s?.alert).toBeUndefined();
  expect(s?.bubble_short).toBe("hi");
});

test("a plain writeState drops the alert (why every writer goes through the merge)", async () => {
  await writeStateKeepingAlert(tmp, next, { set: alert });
  await writeState(tmp, { ...next });
  expect((await readState(tmp))?.alert).toBeUndefined();
});

test("pet and action CLI writes keep the alert", async () => {
  const noon = new Date("2026-05-14T12:00:00Z");
  await writeStateKeepingAlert(tmp, next, { set: alert });
  await runPet({ homeBase: tmp, now: () => noon });
  expect((await readState(tmp))?.alert).toEqual(alert);
  await runActionCli("pet", { homeBase: tmp, now: () => noon });
  expect((await readState(tmp))?.alert).toEqual(alert);
});
