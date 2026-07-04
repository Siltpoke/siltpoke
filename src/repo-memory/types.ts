// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface RepoMemoryFileEntry {
  path: string; // cwd-relative
  sha256: string; // content hash
  lang: string; // ts/tsx/py/etc
  summary_path: string; // relative to summaries/
}

export interface RepoMemoryConvention {
  id: string; // e.g., "naming-kebab-case-files"
  description: string;
  pattern: string; // regex or rule expression
  example_files: string[]; // 2-3 representative
  confidence: number; // 0-1
}

export interface RepoMemoryIndex {
  built_at: string;
  files: RepoMemoryFileEntry[];
  conventions: RepoMemoryConvention[];
}
