import { expect, test } from "bun:test";
import { chatMessageSchema, parseChatMessage } from "../../src/chat/schema";

const validBase = {
  id: "m-abc12345",
  session_id: "s-deadbeef",
  role: "user",
  content: "hello",
  ts: "2026-05-16T00:00:00Z",
};

test("parses minimal valid message with defaults", () => {
  const parsed = parseChatMessage(validBase);
  expect(parsed.model).toBeNull();
  expect(parsed.tokens).toBeNull();
  expect(parsed.fts_skip).toBe(false);
  expect(parsed.claude_session_id).toBeNull();
});

test("parses full message including tokens", () => {
  const parsed = parseChatMessage({
    ...validBase,
    role: "assistant",
    model: "claude-sonnet-4-6",
    tokens: { input: 12, output: 34 },
    fts_skip: true,
    claude_session_id: "cs-1",
  });
  expect(parsed.model).toBe("claude-sonnet-4-6");
  expect(parsed.tokens).toEqual({ input: 12, output: 34 });
  expect(parsed.fts_skip).toBe(true);
  expect(parsed.claude_session_id).toBe("cs-1");
});

test("rejects empty id", () => {
  expect(() => parseChatMessage({ ...validBase, id: "" })).toThrow();
});

test("rejects empty session_id", () => {
  expect(() => parseChatMessage({ ...validBase, session_id: "" })).toThrow();
});

test("rejects invalid role", () => {
  expect(() => parseChatMessage({ ...validBase, role: "robot" })).toThrow();
});

test("rejects negative token counts", () => {
  expect(() =>
    parseChatMessage({
      ...validBase,
      tokens: { input: -1, output: 0 },
    }),
  ).toThrow();
});

test("rejects non-integer token counts", () => {
  expect(() =>
    parseChatMessage({
      ...validBase,
      tokens: { input: 1.5, output: 0 },
    }),
  ).toThrow();
});

test("accepts all four role variants", () => {
  for (const role of ["user", "assistant", "system", "tool_result"] as const) {
    expect(() => parseChatMessage({ ...validBase, role })).not.toThrow();
  }
});

test("safeParse returns success false on bad input", () => {
  const result = chatMessageSchema.safeParse({ id: 1 });
  expect(result.success).toBe(false);
});

// ── turn status (failure-path hardening) ─────────────────────────────────────

test("old rows without status parse unchanged (status absent = ok)", () => {
  const parsed = parseChatMessage(validBase);
  expect(parsed.status).toBeUndefined();
  expect(parsed.error_reason).toBeUndefined();
  expect(parsed.error_message).toBeUndefined();
});

test("parses a failed assistant turn with reason + short message", () => {
  const parsed = parseChatMessage({
    ...validBase,
    role: "assistant",
    content: "",
    status: "failed",
    error_reason: "timeout",
    error_message: "claude -p timed out after 60000ms",
  });
  expect(parsed.status).toBe("failed");
  expect(parsed.error_reason).toBe("timeout");
  expect(parsed.error_message).toBe("claude -p timed out after 60000ms");
});

test("parses a cancelled assistant turn with partial content", () => {
  const parsed = parseChatMessage({
    ...validBase,
    role: "assistant",
    content: "partial rep",
    status: "cancelled",
  });
  expect(parsed.status).toBe("cancelled");
});

test("accepts all three error_reason variants", () => {
  for (const error_reason of ["timeout", "spawn_failed", "empty_exit"] as const) {
    expect(() =>
      parseChatMessage({ ...validBase, status: "failed", error_reason }),
    ).not.toThrow();
  }
});

test("rejects unknown status", () => {
  expect(() => parseChatMessage({ ...validBase, status: "exploded" })).toThrow();
});

test("rejects unknown error_reason", () => {
  expect(() =>
    parseChatMessage({ ...validBase, status: "failed", error_reason: "gremlins" }),
  ).toThrow();
});

test("rejects error_message longer than 300 chars (never a raw stderr blob)", () => {
  expect(() =>
    parseChatMessage({
      ...validBase,
      status: "failed",
      error_message: "x".repeat(301),
    }),
  ).toThrow();
});
