// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync as realExistsSync, readdirSync as realReaddirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EditorPresence {
  vscode: boolean;
  cursor: boolean;
  claudeExtInVscode: boolean;
  claudeExtInCursor: boolean;
}

export function detectEditors(
  deps: { home?: string; existsSync?: (p: string) => boolean; readdirSync?: (p: string) => string[] } = {},
): EditorPresence {
  const home = deps.home ?? homedir();
  const existsSync = deps.existsSync ?? realExistsSync;
  const readdirSync =
    deps.readdirSync ??
    ((p: string) => {
      try {
        return realReaddirSync(p);
      } catch {
        return [];
      }
    });

  const vscodeDir = join(home, ".vscode", "extensions");
  const cursorDir = join(home, ".cursor", "extensions");
  const hasClaudeExt = (dir: string): boolean =>
    existsSync(dir) && readdirSync(dir).some((n) => n.startsWith("anthropic.claude-code"));

  return {
    vscode: existsSync(vscodeDir),
    cursor: existsSync(cursorDir),
    claudeExtInVscode: hasClaudeExt(vscodeDir),
    claudeExtInCursor: hasClaudeExt(cursorDir),
  };
}

export function resolveEditorBranch(
  usesEditor: boolean,
  ed: EditorPresence,
): "A" | "B" | "C" {
  if (ed.claudeExtInVscode || ed.claudeExtInCursor) return "A";
  if (usesEditor || ed.vscode || ed.cursor) return "B";
  return "C";
}

export function editorOpener(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["open"];
  if (platform === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
}

export function extensionScheme(editor: "vscode" | "cursor"): string {
  return `${editor}:extension/anthropic.claude-code`;
}
