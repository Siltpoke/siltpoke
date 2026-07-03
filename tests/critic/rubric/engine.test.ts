import { describe, test, expect } from "bun:test";
import { runRubric } from "../../../src/critic/rubric/engine";
import type { RubricRule } from "../../../src/critic/rubric/types";

describe("rubric engine", () => {
  test("runs all applicable rules in parallel and aggregates triggers", async () => {
    const mockRule: RubricRule = {
      id: "test-rule",
      tier: 2,
      languages: ["ts"],
      async run() {
        return {
          rule_id: "test-rule",
          duration_ms: 1,
          triggers: [{ rule_id: "test-rule", tier: 2, severity: "med", file: "x.ts", line: 1, snippet: "x", message: "y" }],
        };
      },
    };
    const result = await runRubric({ cwd: "/tmp", changedFiles: ["/tmp/x.ts"], diffHunks: [] }, [mockRule]);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].rule_id).toBe("test-rule");
  });

  test("skips rule when no files match language", async () => {
    const mockRule: RubricRule = {
      id: "py-only",
      tier: 2,
      languages: ["py"],
      async run() {
        return { rule_id: "py-only", duration_ms: 0, triggers: [{ rule_id: "py-only", tier: 2, severity: "low", file: "x.py", line: 1, snippet: "x", message: "y" }] };
      },
    };
    const result = await runRubric({ cwd: "/tmp", changedFiles: ["/tmp/x.ts"], diffHunks: [] }, [mockRule]);
    expect(result.triggers).toHaveLength(0);
  });

  test("isolates rule errors (one failing rule doesn't break engine)", async () => {
    const goodRule: RubricRule = {
      id: "good", tier: 1, languages: ["*"],
      async run() { return { rule_id: "good", duration_ms: 0, triggers: [] }; },
    };
    const badRule: RubricRule = {
      id: "bad", tier: 1, languages: ["*"],
      async run() { throw new Error("boom"); },
    };
    const result = await runRubric({ cwd: "/tmp", changedFiles: ["/tmp/x.ts"], diffHunks: [] }, [goodRule, badRule]);
    expect(result.triggers).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rule_id).toBe("bad");
  });
});
