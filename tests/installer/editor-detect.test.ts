import { describe, test, expect } from "bun:test";
import { detectEditors, resolveEditorBranch, editorOpener, extensionScheme } from "../../src/installer/editor-detect";
import type { EditorPresence } from "../../src/installer/editor-detect";

describe("detectEditors", () => {
  test("finds VS Code + the Claude extension", () => {
    const p = detectEditors({
      home: "/Users/x",
      existsSync: (path) => path === "/Users/x/.vscode/extensions",
      readdirSync: (path) =>
        path === "/Users/x/.vscode/extensions" ? ["anthropic.claude-code-1.2.0", "ms-python.python"] : [],
    });
    expect(p.vscode).toBe(true);
    expect(p.claudeExtInVscode).toBe(true);
    expect(p.cursor).toBe(false);
    expect(p.claudeExtInCursor).toBe(false);
  });

  test("VS Code present but no Claude extension", () => {
    const p = detectEditors({
      home: "/Users/x",
      existsSync: (path) => path === "/Users/x/.vscode/extensions",
      readdirSync: () => ["ms-python.python"],
    });
    expect(p.vscode).toBe(true);
    expect(p.claudeExtInVscode).toBe(false);
  });
});

const noEd: EditorPresence = {
  vscode: false,
  cursor: false,
  claudeExtInVscode: false,
  claudeExtInCursor: false,
};

describe("resolveEditorBranch", () => {
  test("A when the Claude Code extension is present (vscode or cursor)", () => {
    expect(resolveEditorBranch(false, { ...noEd, claudeExtInVscode: true })).toBe("A");
    expect(resolveEditorBranch(false, { ...noEd, claudeExtInCursor: true })).toBe("A");
  });
  test("B when an editor is detected or the user says they use one, but no plugin", () => {
    expect(resolveEditorBranch(false, { ...noEd, vscode: true })).toBe("B");
    expect(resolveEditorBranch(false, { ...noEd, cursor: true })).toBe("B");
    expect(resolveEditorBranch(true, noEd)).toBe("B");
  });
  test("C when bare — no plugin, no editor, user says no", () => {
    expect(resolveEditorBranch(false, noEd)).toBe("C");
  });
});

describe("editorOpener / extensionScheme", () => {
  test("per-platform opener", () => {
    expect(editorOpener("darwin")).toEqual(["open"]);
    expect(editorOpener("linux")).toEqual(["xdg-open"]);
    expect(editorOpener("win32")).toEqual(["cmd", "/c", "start", ""]);
  });
  test("extension deep-link scheme", () => {
    expect(extensionScheme("vscode")).toBe("vscode:extension/anthropic.claude-code");
    expect(extensionScheme("cursor")).toBe("cursor:extension/anthropic.claude-code");
  });
});
