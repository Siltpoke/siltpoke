import { describe, test, expect } from "bun:test";
import { classifyIntent } from "../../../src/critic/intent/classifier";

describe("classifyIntent", () => {
  test("commit msg 'fix: null guard' → bugfix high confidence", () => {
    const result = classifyIntent({ user_message: "", commit_msg: "fix: null guard in auth", changed_file_exts: new Set(["ts"]) });
    expect(result.classification).toBe("bugfix");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("user message 'I'm refactoring the parser' → refactor", () => {
    const result = classifyIntent({ user_message: "I'm refactoring the parser to use a state machine", commit_msg: null, changed_file_exts: new Set(["ts"]) });
    expect(result.classification).toBe("refactor");
  });

  test("only test/docs files touched + 'add' → feature with chore signal", () => {
    const result = classifyIntent({ user_message: "add docs for new API", commit_msg: null, changed_file_exts: new Set(["md"]) });
    // feature keyword wins; chore signal noted in signals[]
    expect(result.classification).toBe("feature");
    expect(result.signals.length).toBeGreaterThan(0);
  });

  test("no signal anywhere → exploration with low confidence", () => {
    const result = classifyIntent({ user_message: "ok", commit_msg: null, changed_file_exts: new Set(["ts"]) });
    expect(result.classification).toBe("exploration");
    expect(result.confidence).toBeLessThan(0.5);
  });

  test("'add new bugfix flag for legacy fallback' → feature wins on confidence sum, but bug signal recorded", () => {
    const result = classifyIntent({ user_message: "add new bugfix flag for legacy fallback", commit_msg: null, changed_file_exts: new Set(["ts"]) });
    expect(result.classification).toBe("feature");
    expect(result.signals.some(s => s.matched_rule_id.startsWith("bugfix-"))).toBe(true);
  });
});
