import { describe, expect, it } from "bun:test";
import { factSchema } from "../../src/memory/memory";

describe("factSchema save_reason", () => {
  it("defaults save_reason to null when absent (legacy round-trip)", () => {
    const legacy = {
      id: "f1", text: "uses Bun", source_session_id: null, confidence: 0.8,
      status: "active", created_at: "2026-06-01T00:00:00.000Z",
      last_seen_at: "2026-06-01T00:00:00.000Z", supersedes: null,
    };
    const parsed = factSchema.parse(legacy);
    expect(parsed.save_reason).toBeNull();
  });

  it("preserves a provided save_reason", () => {
    const parsed = factSchema.parse({
      id: "f2", text: "prefers TDD", source_session_id: null, confidence: 0.9,
      status: "active", created_at: "2026-06-01T00:00:00.000Z",
      last_seen_at: "2026-06-01T00:00:00.000Z", supersedes: null,
      save_reason: "recurring across 3 sessions",
    });
    expect(parsed.save_reason).toBe("recurring across 3 sessions");
  });
});
