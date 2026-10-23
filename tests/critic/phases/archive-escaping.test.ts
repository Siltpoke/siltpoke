import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeV2Archive } from "../../../src/critic/phases/archive";
import { loadV2Sidecar } from "../../../src/state/v2-sidecar";
import type { RubricTrigger } from "../../../src/critic/rubric/types";
import type { BrainContext } from "../../../src/critic/types";

// The evidence `message:` is written as a double-quoted value. Escaping only the
// quote (CodeQL js/incomplete-sanitization) made a Windows path's backslashes
// ambiguous, and the reader never undid the escape, so a quote came back as `\"`.

let stateBase: string;
beforeEach(() => {
  stateBase = mkdtempSync(join(tmpdir(), "siltpoke-archive-esc-"));
});
afterEach(() => {
  rmSync(stateBase, { recursive: true, force: true });
});

const brainContext = { sessionId: "s-esc", cwd: "/repo" } as unknown as BrainContext;

async function roundTrip(message: string): Promise<string | undefined> {
  const trigger = {
    rule_id: "r1", tier: 1, severity: "warn", file: "a.ts", line: 3, snippet: "x", message,
  } as unknown as RubricTrigger;
  await writeV2Archive(stateBase, "c-esc", brainContext, { pipelineRan: true, rubricTriggers: [trigger] });
  const data = await loadV2Sidecar("c-esc", null, stateBase);  return data?.rubric_triggers[0]?.message;
}

test("a message with quotes comes back without escape backslashes", async () => {
  expect(await roundTrip('expected "foo" here')).toBe('expected "foo" here');
});

test("a Windows path survives the round trip", async () => {
  expect(await roundTrip("C:\\Users\\vic\\app.ts")).toBe("C:\\Users\\vic\\app.ts");
});

test("a UNC path keeps both leading backslashes", async () => {
  expect(await roundTrip("\\\\server\\share\\a.ts")).toBe("\\\\server\\share\\a.ts");
});

test("a backslash right before a quote survives", async () => {
  expect(await roundTrip('ends with \\"q\\"')).toBe('ends with \\"q\\"');
});

test("a trailing backslash does not swallow the closing quote", async () => {
  expect(await roundTrip("dir\\")).toBe("dir\\");
});
