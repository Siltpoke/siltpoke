import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateTriggerMode,
  loadTriggerConfig,
  DEFAULT_TRIGGER_CONFIG,
  type TriggerConfig,
} from "../../src/router/trigger-modes";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-trig-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const stopEvent = { hook_event_name: "Stop" };
const otherEvent = { hook_event_name: "Notification" };

const baseConfig: TriggerConfig = { ...DEFAULT_TRIGGER_CONFIG };

test("always mode: fires on any event", () => {
  const cfg: TriggerConfig = { mode: "always", gateEvents: [] };
  expect(evaluateTriggerMode(stopEvent, cfg, false).fire).toBe(true);
  expect(evaluateTriggerMode(otherEvent, cfg, false).fire).toBe(true);
});

test("gates mode: fires on Stop, skips Notification", () => {
  expect(evaluateTriggerMode(stopEvent, baseConfig, false).fire).toBe(true);
  const skip = evaluateTriggerMode(otherEvent, baseConfig, false);
  expect(skip.fire).toBe(false);
  expect(skip.reason).toBe("wrong_event_mode");
});

test("on_demand mode without bypass: never fires", () => {
  const cfg: TriggerConfig = { mode: "on_demand", gateEvents: [] };
  const skip = evaluateTriggerMode(stopEvent, cfg, false);
  expect(skip.fire).toBe(false);
  expect(skip.reason).toBe("on_demand_no_bypass");
});

test("on_demand mode with bypass: fires", () => {
  const cfg: TriggerConfig = { mode: "on_demand", gateEvents: [] };
  expect(evaluateTriggerMode(stopEvent, cfg, true).fire).toBe(true);
});

test("hybrid mode: fires on gate event without bypass", () => {
  const cfg: TriggerConfig = { mode: "hybrid", gateEvents: ["Stop"] };
  expect(evaluateTriggerMode(stopEvent, cfg, false).fire).toBe(true);
});

test("hybrid mode: bypass forces fire on non-gate event", () => {
  const cfg: TriggerConfig = { mode: "hybrid", gateEvents: ["Stop"] };
  expect(evaluateTriggerMode(otherEvent, cfg, true).fire).toBe(true);
});

test("loadTriggerConfig: defaults when config.json missing", async () => {
  const cfg = await loadTriggerConfig(tmp);
  expect(cfg.mode).toBe("gates");
  expect(cfg.gateEvents).toEqual(["Stop", "PreCompact"]);
});

test("loadTriggerConfig: custom mode + gateEvents", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      triggerMode: "always",
      gateEvents: ["Stop", "Notification"],
    }),
  );
  const cfg = await loadTriggerConfig(tmp);
  expect(cfg.mode).toBe("always");
  expect(cfg.gateEvents).toEqual(["Stop", "Notification"]);
});

test("loadTriggerConfig: bad mode falls back to gates", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ triggerMode: "garbage" }),
  );
  const cfg = await loadTriggerConfig(tmp);
  expect(cfg.mode).toBe("gates");
});
