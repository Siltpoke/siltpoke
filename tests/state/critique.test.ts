import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCritique } from "../../src/state/critique";
import type { BrainOutput } from "../../src/brain/schema";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-crit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sampleOut: BrainOutput = {
  mood: "annoyed",
  pose: "arms_crossed",
  bubble_short: "INNER JOIN drops users without profile",
  bubble_long: "Long explanation here.",
  critique_for_claude: "queries.py:47 — wrong JOIN type",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
  evidence: [],
      reasoning: "test fixture",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("writeCritique creates a date-stamped archive file", async () => {
  const r = await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  expect(r.id).toMatch(/^c-[0-9a-f]{4}$/);
  expect(existsSync(r.path)).toBe(true);
  expect(r.path).toContain(`critiques/archive/${today()}`);
});

test("writeCritique appends one history.jsonl line", async () => {
  await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  const history = readFileSync(
    join(tmp, "critiques", "history.jsonl"),
    "utf8",
  );
  const lines = history.trim().split("\n");
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.severity).toBe("medium");
  expect(parsed.bubble_short).toBe(sampleOut.bubble_short);
});

test("writeCritique refreshes latest.md to match the new file", async () => {
  const r = await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  const archive = readFileSync(r.path, "utf8");
  const latest = readFileSync(join(tmp, "critiques", "latest.md"), "utf8");
  expect(latest).toBe(archive);
});

test("markdown contains frontmatter, safety prefix, and bubble", async () => {
  const r = await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  const md = readFileSync(r.path, "utf8");
  expect(md).toContain("schemaVersion: 1");
  expect(md).toContain("severity: medium");
  expect(md).toContain("[SILTPOKE CRITIQUE]");
  expect(md).toContain(sampleOut.bubble_short);
  expect(md).toContain(sampleOut.critique_for_claude);
});

test("backticks in critique_for_claude do not break the fence", async () => {
  const evil: BrainOutput = {
    ...sampleOut,
    critique_for_claude: "```ts\nbad();\n```\n```\nmore\n```",
  };
  const r = await writeCritique(tmp, {
    brain_output: evil,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  const md = readFileSync(r.path, "utf8");
  // Fence used must be longer than longest backtick run in the body (3 here),
  // so the rendered markdown still parses with the critique block intact.
  expect(md).toContain("````");
  expect(md).toContain(evil.critique_for_claude);
});

test("two writes get distinct IDs", async () => {
  const a = await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  const b = await writeCritique(tmp, {
    brain_output: sampleOut,
    session_id: "s1",
    cwd: "/tmp/proj",
  });
  expect(a.id).not.toBe(b.id);
});
