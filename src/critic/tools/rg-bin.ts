// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";

// Resolve a REAL ripgrep binary, not a shell-function wrapper. On this machine
// `rg` on PATH is a Claude Code / RTK shim that child processes can't exec, so a
// bare `rg` argv fails with "Executable not found". Prefer the Cursor-bundled
// `@vscode/ripgrep` binary (genuine ripgrep), overridable for tests / CI.
//
// `sprawling-abstraction.ts` carries an equivalent private copy of this logic;
// this module is the reusable home new tools should import, and that copy is a
// consolidation candidate (not migrated here to keep this task surgical).
const CURSOR_RG =
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg";

export function getRgBin(): string {
  if (process.env.RG_BIN_OVERRIDE) return process.env.RG_BIN_OVERRIDE;
  if (existsSync(CURSOR_RG)) return CURSOR_RG;
  return "rg";
}
