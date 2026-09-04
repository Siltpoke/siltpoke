// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { ReviewSubject } from "./review-subject";

export type ToolName = "tsc" | "eslint" | "git-diff" | "ripgrep";

export type ToolStatus =
  | "ok"
  | "not_applicable"
  | "not_installed"
  | "timeout"
  | "error"
  | "output_too_large";

export type TscDiagnostic = {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type EslintFinding = {
  file: string;
  line: number;
  col: number;
  severity: "warning" | "error";
  ruleId: string;
  message: string;
};

export type GitDiffHunk = {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  body: string;
};

export type RipgrepMatch = {
  file: string;
  line: number;
  text: string;
  pattern: string;
};

export type ToolResult =
  | { tool: "tsc"; status: ToolStatus; parsed: TscDiagnostic[]; raw: string }
  | { tool: "eslint"; status: ToolStatus; parsed: EslintFinding[]; raw: string }
  | {
      tool: "git-diff";
      status: ToolStatus;
      parsed: GitDiffHunk[];
      raw: string;
      /**
       * Set ONLY by the recent-commits fallback, whose blob spans several commits.
       * Names the one commit a critique may attribute the diff's intent to; absent
       * on a plain `git diff`, where the working tree has no commit message at all.
       */
      reviewSubject?: ReviewSubject;
    }
  | { tool: "ripgrep"; status: ToolStatus; parsed: RipgrepMatch[]; raw: string };
