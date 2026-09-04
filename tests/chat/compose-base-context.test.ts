// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, it, expect } from "bun:test";
import { composeBaseSystemPrompt } from "../../src/chat/compose-base-context";

describe("composeBaseSystemPrompt quiz precedence", () => {
  it("returns quizPrompt verbatim, ignoring anchor and page", async () => {
    const out = await composeBaseSystemPrompt({
      quizPrompt: "QUIZ-CONDUCTOR-PROMPT",
      anchorCtx: { systemPrompt: "ANCHOR", contextBundle: "BUNDLE" },
      pageId: "repo-graph",
      homeBase: "/tmp/nope",
    });
    expect(out).toBe("QUIZ-CONDUCTOR-PROMPT");
  });
});
