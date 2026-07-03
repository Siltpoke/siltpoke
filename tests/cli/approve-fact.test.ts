import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApproveFact, parseApproveFactArgs } from "../../src/cli/approve-fact";
import { readMemory, writeMemory, emptyMemory } from "../../src/memory/memory";
import type { CoreMemory } from "../../src/memory/memory";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-approve-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date("2026-05-16T12:00:00Z");
const NOW_ISO = NOW.toISOString();

// Helper — seed memory with a fact at given status
async function seedFact(
  homeBase: string,
  id: string,
  status: "pending" | "active" | "retired",
): Promise<void> {
  const base = emptyMemory();
  const memory: CoreMemory = {
    ...base,
    facts: [
      {
        id,
        text: `claim for ${id}`,
        source_session_id: null,
        confidence: 0.85,
        status,
        created_at: "2026-05-01T00:00:00Z",
        last_seen_at: "2026-05-01T00:00:00Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: null,
        last_confirmed_at: null,
        expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
        kind: null,
      },
    ],
  };
  await writeMemory(homeBase, memory);
}

const throwingRead = async (): Promise<CoreMemory | null> => {
  throw new Error("disk error");
};

const throwingWrite = async (): Promise<void> => {
  throw new Error("disk full");
};

// ---------------------------------------------------------------------------
// parseApproveFactArgs unit tests
// ---------------------------------------------------------------------------

test("parseApproveFactArgs: valid id", () => {
  const r = parseApproveFactArgs(["f-abc12345"]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.id).toBe("f-abc12345");
});

test("parseApproveFactArgs: missing id → error", () => {
  const r = parseApproveFactArgs([]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("missing fact id");
});

test("parseApproveFactArgs: unknown flag → error", () => {
  const r = parseApproveFactArgs(["--force"]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("--force");
});

// ---------------------------------------------------------------------------
// runApproveFact integration tests
// ---------------------------------------------------------------------------

test("approve pending fact: status flips to active, last_seen_at bumped, exit 0", async () => {
  await seedFact(tmp, "f-pending1", "pending");
  const messages: string[] = [];

  const code = await runApproveFact({
    argv: ["f-pending1"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
  });

  expect(code).toBe(0);
  expect(messages[0]).toContain("approved fact f-pending1");
  expect(messages[0]).toContain("claim for f-pending1");

  const memory = await readMemory(tmp);
  const fact = memory?.facts.find((f) => f.id === "f-pending1");
  expect(fact?.status).toBe("active");
  expect(fact?.last_seen_at).toBe(NOW_ISO);
  // Approval stamps last_confirmed_at so the durable-staleness
  // clock resets on /siltpoke-approve.
  expect(fact?.last_confirmed_at).toBe(NOW_ISO);
});

test("approve already-active fact → exit 2 with not pending message", async () => {
  await seedFact(tmp, "f-active1", "active");
  const messages: string[] = [];

  const code = await runApproveFact({
    argv: ["f-active1"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
  });

  expect(code).toBe(2);
  expect(messages[0]).toContain("is not pending");
  expect(messages[0]).toContain("active");
});

test("approve already-retired fact → exit 2", async () => {
  await seedFact(tmp, "f-retired1", "retired");
  const messages: string[] = [];

  const code = await runApproveFact({
    argv: ["f-retired1"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
  });

  expect(code).toBe(2);
  expect(messages[0]).toContain("is not pending");
  expect(messages[0]).toContain("retired");
});

test("approve unknown fact id → exit 1 with fact not found", async () => {
  await seedFact(tmp, "f-other", "pending");
  const messages: string[] = [];

  const code = await runApproveFact({
    argv: ["f-unknown"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("fact not found");
  expect(messages[0]).toContain("f-unknown");
});

test("missing id arg → exit 3", async () => {
  const messages: string[] = [];
  const code = await runApproveFact({
    argv: [],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
  });

  expect(code).toBe(3);
  expect(messages[0]).toContain("missing fact id");
});

test("readMemory throws → exit 1", async () => {
  const messages: string[] = [];
  const code = await runApproveFact({
    argv: ["f-x"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { readMemory: throwingRead },
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("read failed");
});

test("writeMemory throws → exit 1", async () => {
  await seedFact(tmp, "f-pend2", "pending");
  const messages: string[] = [];

  const code = await runApproveFact({
    argv: ["f-pend2"],
    homeBase: tmp,
    now: NOW,
    output: (m) => messages.push(m),
    deps: { writeMemory: throwingWrite },
  });

  expect(code).toBe(1);
  expect(messages[0]).toContain("write failed");
});

test("approve does not mutate other facts in memory", async () => {
  const base = emptyMemory();
  const memory: CoreMemory = {
    ...base,
    facts: [
      {
        id: "f-pend3",
        text: "will approve",
        source_session_id: null,
        confidence: 0.8,
        status: "pending",
        created_at: "2026-05-01T00:00:00Z",
        last_seen_at: "2026-05-01T00:00:00Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: null,
        last_confirmed_at: null,
        expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
      },
      {
        id: "f-other2",
        text: "untouched",
        source_session_id: null,
        confidence: 0.9,
        status: "active",
        created_at: "2026-05-01T00:00:00Z",
        last_seen_at: "2026-05-01T00:00:00Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: null,
        last_confirmed_at: null,
        expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
      },
    ],
  };
  await writeMemory(tmp, memory);

  await runApproveFact({
    argv: ["f-pend3"],
    homeBase: tmp,
    now: NOW,
    output: () => undefined,
  });

  const after = await readMemory(tmp);
  const other = after?.facts.find((f) => f.id === "f-other2");
  expect(other?.status).toBe("active");
  expect(other?.last_seen_at).toBe("2026-05-01T00:00:00Z");
});
