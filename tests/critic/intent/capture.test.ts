/**
 * Tests for captureIntent() — simplified post-walkback.
 *
 * After the alignment/reasoning infra was removed, captureIntent now only
 * surfaces `user_raw_query` (last non-empty user transcript turn, after
 * stripping image-source pastes and synthetic hook-marker blocks).
 */

import { describe, test, expect } from "bun:test";
import { captureIntent, type TranscriptTurn } from "../../../src/critic/intent/capture";

function user(text: string): TranscriptTurn {
  return { role: "user", text };
}

function assistant(text: string): TranscriptTurn {
  return { role: "assistant", text };
}

describe("captureIntent", () => {
  test("returns last non-empty user message verbatim", () => {
    const turns: TranscriptTurn[] = [
      user("first message"),
      assistant("I'll work on it."),
      user("Actually, do this instead."),
      assistant("OK."),
    ];

    expect(captureIntent(turns).user_raw_query).toBe("Actually, do this instead.");
  });

  test("empty transcript → user_raw_query null", () => {
    expect(captureIntent([]).user_raw_query).toBeNull();
  });

  test("only assistant turns → user_raw_query null", () => {
    const turns: TranscriptTurn[] = [assistant("I'll do something.")];
    expect(captureIntent(turns).user_raw_query).toBeNull();
  });

  test("strips `[Image: source: ...]` paste-only turns and falls back to earlier user turn", () => {
    const turns: TranscriptTurn[] = [
      user("Refactor the diff parser to handle 512KB inputs."),
      assistant("Working on it."),
      user("[Image: source: /tmp/a.png]\n[Image: source: /tmp/b.png]"),
    ];

    expect(captureIntent(turns).user_raw_query).toBe(
      "Refactor the diff parser to handle 512KB inputs.",
    );
  });

  test("image-source-only as the only user turn → null", () => {
    const turns: TranscriptTurn[] = [user("[Image: source: /tmp/a.png]")];
    expect(captureIntent(turns).user_raw_query).toBeNull();
  });

  test("mixed image + text user turn keeps text portion", () => {
    const turns: TranscriptTurn[] = [
      user("[Image: source: /tmp/a.png]\nplease fix this bug"),
    ];
    expect(captureIntent(turns).user_raw_query).toBe("please fix this bug");
  });

  test("hook-marker user turn is treated as empty and falls back", () => {
    const turns: TranscriptTurn[] = [
      user("Write the README."),
      assistant("OK."),
      user("<user-prompt-submit-hook>...</user-prompt-submit-hook>"),
    ];
    expect(captureIntent(turns).user_raw_query).toBe("Write the README.");
  });

  test("whitespace-only user turn is treated as empty", () => {
    const turns: TranscriptTurn[] = [user("   \n  ")];
    expect(captureIntent(turns).user_raw_query).toBeNull();
  });

  test("commitMsg parameter is accepted for backwards compat but ignored", () => {
    const turns: TranscriptTurn[] = [user("Fix the bug.")];
    const result = captureIntent(turns, "fix: null guard");
    expect(result.user_raw_query).toBe("Fix the bug.");
    // No agent fields exist on the simplified CapturedIntent.
  });
});
