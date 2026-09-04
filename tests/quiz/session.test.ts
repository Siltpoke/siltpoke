import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyOverlay } from "../../src/quiz/index";
import {
  serializeQuizState, deserializeQuizState,
  writeQuizState, readQuizState, deleteQuizState, quizSidecarPath,
  type QuizSessionState,
} from "../../src/quiz/session";

function sampleState(): QuizSessionState {
  const overlay = emptyOverlay();
  overlay.supported.add("a->b");
  overlay.userEntities.add("a");
  return {
    mode: "quiz",
    scope: { moduleId: "src/daemon" },
    overlay,
    currentTarget: { kind: "dependency_edge", a: "a", b: "b" },
    ladderStep: null,
    turnCount: 2,
    wrappedUp: false,
    projHash: "abc123",
  };
}

describe("quiz session state", () => {
  it("round-trips Set fields through JSON", () => {
    const back = deserializeQuizState(serializeQuizState(sampleState()));
    expect(back.overlay.supported.has("a->b")).toBe(true);
    expect(back.overlay.userEntities.has("a")).toBe(true);
    expect(back.currentTarget).toEqual({ kind: "dependency_edge", a: "a", b: "b" });
    expect(back.turnCount).toBe(2);
    expect(back.projHash).toBe("abc123");
  });

  it("persists and reloads via sidecar; null when absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "quiz-sess-"));
    expect(await readQuizState(home, "s1")).toBeNull();
    await writeQuizState(home, "s1", sampleState());
    expect(quizSidecarPath(home, "s1")).toBe(join(home, "chats", "s1.quiz.json"));
    const loaded = await readQuizState(home, "s1");
    expect(loaded?.overlay.supported.has("a->b")).toBe(true);
    await deleteQuizState(home, "s1");
    expect(await readQuizState(home, "s1")).toBeNull();
  });

  it("fails open (returns null, does not throw) on a corrupt/truncated sidecar", async () => {
    const home = mkdtempSync(join(tmpdir(), "quiz-sess-corrupt-"));
    const path = quizSidecarPath(home, "s1");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not valid json", "utf8");
    await expect(readQuizState(home, "s1")).resolves.toBeNull();
  });
});
