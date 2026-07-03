import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInbox } from "../../src/cli/list-inbox";
import { writeMemory, emptyMemory, type CoreMemory } from "../../src/memory/memory";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-inbox-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCritique(
  basePath: string,
  date: string,
  id: string,
  status: string,
): string {
  const dir = join(basePath, "critiques", "archive", date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(
    path,
    `---\nschemaVersion: 1\ncritique_id: ${id}\nstatus: ${status}\n---\nbody\n`,
  );
  return path;
}

function appendHistory(
  basePath: string,
  entry: Record<string, unknown>,
): void {
  const historyPath = join(basePath, "critiques", "history.jsonl");
  mkdirSync(join(basePath, "critiques"), { recursive: true });
  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
}

test("empty inbox when history.jsonl missing", async () => {
  const out = await listInbox({ basePath: tmp });
  expect(out).toContain("inbox is empty");
});

test("lists pending entries with id + severity + bubble", async () => {
  const path = writeCritique(tmp, "2026-05-14", "c-a7b3", "pending");
  appendHistory(tmp, {
    timestamp: "2026-05-14T10:00:00Z",
    critique_id: "c-a7b3",
    severity: "medium",
    bubble_short: "INNER JOIN drops users",
    path,
  });
  const out = await listInbox({ basePath: tmp });
  expect(out).toContain("c-a7b3");
  expect(out).toContain("medium");
  expect(out).toContain("INNER JOIN drops users");
});

// ---------------------------------------------------------------------------
// --facts flag (PQ7)
// ---------------------------------------------------------------------------

function makeFact(
  overrides: Partial<CoreMemory["facts"][number]>,
): CoreMemory["facts"][number] {
  return {
    id: "f-0001",
    text: "Default fact claim text",
    source_session_id: null,
    confidence: 0.75,
    status: "pending",
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
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
    ...overrides,
  };
}

async function writeMemoryWithFacts(
  basePath: string,
  facts: CoreMemory["facts"],
): Promise<void> {
  const mem: CoreMemory = { ...emptyMemory(), facts };
  await writeMemory(basePath, mem);
}

test("--facts: no memory file → 'no pending facts'", async () => {
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("no pending facts");
});

test("--facts: empty pending list → 'no pending facts', exit 0", async () => {
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-active", status: "active" }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("no pending facts");
});

test("--facts: 3 pending facts → 3 rows + footer", async () => {
  const now = new Date();
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-0001", text: "First pending fact", created_at: new Date(now.getTime() - 3_600_000).toISOString() }),
    makeFact({ id: "f-0002", text: "Second pending fact", created_at: new Date(now.getTime() - 7_200_000).toISOString() }),
    makeFact({ id: "f-0003", text: "Third pending fact", created_at: new Date(now.getTime() - 10_800_000).toISOString() }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("f-0001");
  expect(out).toContain("f-0002");
  expect(out).toContain("f-0003");
  expect(out).toContain("3 pending facts");
  expect(out).toContain("/siltpoke-approve <id>");
  expect(out).toContain("/siltpoke-reject <id>");
});

test("--facts: 1 active + 2 pending → only 2 pending rows", async () => {
  const now = new Date();
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-active", status: "active" }),
    makeFact({ id: "f-p1", status: "pending", created_at: new Date(now.getTime() - 1_000).toISOString() }),
    makeFact({ id: "f-p2", status: "pending", created_at: new Date(now.getTime() - 2_000).toISOString() }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).not.toContain("f-active");
  expect(out).toContain("f-p1");
  expect(out).toContain("f-p2");
  expect(out).toContain("2 pending facts");
});

test("--facts: confidence formatted to 2 decimal places", async () => {
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-conf", confidence: 0.85 }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("conf=0.85");
});

test("--facts: row contains id, claim, conf, relative time", async () => {
  const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // ~2d ago
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-row1", text: "Check row structure here", confidence: 0.77, created_at: createdAt }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("f-row1");
  expect(out).toContain("Check row structure here");
  expect(out).toContain("conf=0.77");
  expect(out).toContain("d ago");
});

test("--facts: sorted newest first", async () => {
  const now = Date.now();
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-old", created_at: new Date(now - 10_000).toISOString() }),
    makeFact({ id: "f-new", created_at: new Date(now - 1_000).toISOString() }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  const newIdx = out.indexOf("f-new");
  const oldIdx = out.indexOf("f-old");
  expect(newIdx).toBeLessThan(oldIdx);
});

test("--facts: claim trimmed to 60 chars with ellipsis", async () => {
  const longText = "A".repeat(80);
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-long", text: longText }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  // Should contain exactly 60 A's followed by the ellipsis character
  expect(out).toContain(`${"A".repeat(60)}…`);
  // Must NOT contain 61 consecutive A's (confirms truncation happened)
  expect(out).not.toContain("A".repeat(61));
});

test("--facts: claim exactly 60 chars → no ellipsis", async () => {
  const exactText = "B".repeat(60);
  await writeMemoryWithFacts(tmp, [
    makeFact({ id: "f-exact", text: exactText }),
  ]);
  const out = await listInbox({ basePath: tmp, facts: true });
  expect(out).toContain("B".repeat(60));
  expect(out).not.toContain(`${"B".repeat(60)}…`);
});

test("excludes forwarded entries", async () => {
  const pendingPath = writeCritique(tmp, "2026-05-14", "c-aaaa", "pending");
  const forwardedPath = writeCritique(tmp, "2026-05-14", "c-bbbb", "forwarded");
  appendHistory(tmp, {
    timestamp: "2026-05-14T10:00:00Z",
    critique_id: "c-aaaa",
    severity: "low",
    bubble_short: "pending one",
    path: pendingPath,
  });
  appendHistory(tmp, {
    timestamp: "2026-05-14T10:05:00Z",
    critique_id: "c-bbbb",
    severity: "high",
    bubble_short: "already forwarded",
    path: forwardedPath,
  });

  const out = await listInbox({ basePath: tmp });
  expect(out).toContain("c-aaaa");
  expect(out).toContain("pending one");
  expect(out).not.toContain("c-bbbb");
  expect(out).not.toContain("already forwarded");
});
