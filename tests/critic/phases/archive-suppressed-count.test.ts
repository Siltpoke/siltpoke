import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeV2Archive } from "../../../src/critic/phases/archive";
import type { BrainContext, V2ResultFields } from "../../../src/critic/types";

let stateBase: string;

beforeEach(() => {
  stateBase = mkdtempSync(join(tmpdir(), "siltpoke-archive-"));
});
afterEach(() => {
  rmSync(stateBase, { recursive: true, force: true });
});

const brainContext = { sessionId: "s-1", cwd: "/repo" } as unknown as BrainContext;

function readArchive(): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(stateBase, "critiques", "archive", day);
  const file = readdirSync(dir).find((f) => f.endsWith(".v2.md"));
  return readFileSync(join(dir, file ?? ""), "utf8");
}

describe("writeV2Archive — rubric_suppressed_count (observability honesty)", () => {
  test("a suppressed Stop records 0 surfaced but a non-zero suppressed count", async () => {
    const v2: V2ResultFields = {
      pipelineRan: true,
      rubricTriggers: [], // all flags suppressed this Stop
      rubricSuppressedCount: 3,
    };
    await writeV2Archive(stateBase, "c-1.v2", brainContext, v2);
    const text = readArchive();
    expect(text).toContain("rubric_trigger_count: 0");
    expect(text).toContain("rubric_suppressed_count: 3");
  });

  test("defaults to 0 when the field is absent (back-compat)", async () => {
    const v2: V2ResultFields = { pipelineRan: true, rubricTriggers: [] };
    await writeV2Archive(stateBase, "c-2.v2", brainContext, v2);
    expect(readArchive()).toContain("rubric_suppressed_count: 0");
  });
});
