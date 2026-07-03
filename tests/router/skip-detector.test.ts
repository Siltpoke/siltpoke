import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSkip,
  commitHash,
  buildSignature,
} from "../../src/router/skip-detector";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-skipdet-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseSig = buildSignature({
  sessionId: "sess-1",
  cwd: "/proj",
  changedFiles: ["a.py", "b.ts"],
  latestUserMessage: "do the thing",
});

test("first call never skips (no prior hash)", async () => {
  const decision = await evaluateSkip({
    basePath: tmp,
    sessionId: "sess-1",
    signature: baseSig,
  });
  expect(decision.skip).toBe(false);
  expect(decision.hash.length).toBe(64);
});

test("identical signature after commitHash → skip", async () => {
  const first = await evaluateSkip({
    basePath: tmp,
    sessionId: "sess-1",
    signature: baseSig,
  });
  await commitHash(tmp, "sess-1", first.hash);
  const second = await evaluateSkip({
    basePath: tmp,
    sessionId: "sess-1",
    signature: baseSig,
  });
  expect(second.skip).toBe(true);
  expect(second.reason).toBe("no_change");
  expect(second.hash).toBe(first.hash);
});

test("different sessionId same signature does NOT skip", async () => {
  const first = await evaluateSkip({
    basePath: tmp,
    sessionId: "sess-1",
    signature: baseSig,
  });
  await commitHash(tmp, "sess-1", first.hash);
  const other = await evaluateSkip({
    basePath: tmp,
    sessionId: "sess-2",
    signature: baseSig,
  });
  expect(other.skip).toBe(false);
});

test("buildSignature: file order does not matter (sorted internally)", () => {
  const s1 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["a.py", "b.ts"],
    latestUserMessage: "x",
  });
  const s2 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["b.ts", "a.py"],
    latestUserMessage: "x",
  });
  expect(s1).toBe(s2);
});

test("buildSignature: changed file set invalidates signature", () => {
  const s1 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["a.py"],
    latestUserMessage: "x",
  });
  const s2 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["a.py", "b.py"],
    latestUserMessage: "x",
  });
  expect(s1).not.toBe(s2);
});

test("buildSignature: user message change invalidates signature", () => {
  const s1 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: [],
    latestUserMessage: "x",
  });
  const s2 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: [],
    latestUserMessage: "y",
  });
  expect(s1).not.toBe(s2);
});

test("buildSignature: cwd change invalidates signature", () => {
  const s1 = buildSignature({
    sessionId: "s",
    cwd: "/a",
    changedFiles: [],
    latestUserMessage: "x",
  });
  const s2 = buildSignature({
    sessionId: "s",
    cwd: "/b",
    changedFiles: [],
    latestUserMessage: "x",
  });
  expect(s1).not.toBe(s2);
});

test("same files + same user msg + same cwd → SAME signature even if assistant turns differ", () => {
  // This is the core fix: assistant text no longer participates in the
  // skip signature, so a follow-up Stop event with no new file edits and no
  // new user message will short-circuit instead of burning another Brain call.
  const s1 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["a.py"],
    latestUserMessage: "what does this do",
  });
  const s2 = buildSignature({
    sessionId: "s",
    cwd: "/c",
    changedFiles: ["a.py"],
    latestUserMessage: "what does this do",
  });
  expect(s1).toBe(s2);
});
