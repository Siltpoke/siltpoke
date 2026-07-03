// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { glob } from "node:fs/promises";
import { summarizeFile, type SummarizeFn } from "./summarizer.ts";
import type { RepoMemoryIndex, RepoMemoryFileEntry, RepoMemoryConvention } from "./types.ts";

const DEFAULT_DIR = join(homedir(), ".siltpoke", "repo-memory");

export interface BuildOpts {
  cwd: string;
  pattern?: string;
  memoryDir?: string;
  summarize?: SummarizeFn;
}

function detectConventions(files: RepoMemoryFileEntry[]): RepoMemoryConvention[] {
  const conventions: RepoMemoryConvention[] = [];

  // Naming convention: kebab-case file names
  const kebabFiles = files.filter((f) => /\/[a-z]+(-[a-z]+)*\.[a-z]+$/.test(f.path));
  if (files.length >= 5 && kebabFiles.length / files.length >= 0.8) {
    conventions.push({
      id: "naming-kebab-case-files",
      description: "File names use kebab-case",
      pattern: "^[a-z]+(-[a-z]+)*\\.(ts|tsx|js|jsx)$",
      example_files: kebabFiles.slice(0, 3).map((f) => f.path),
      confidence: kebabFiles.length / files.length,
    });
  }

  // For v1: just kebab; richer conventions can come later
  return conventions;
}

export async function buildRepoMemoryIndex(opts: BuildOpts): Promise<RepoMemoryIndex> {
  const memoryDir = opts.memoryDir ?? DEFAULT_DIR;
  const summariesDir = join(memoryDir, "summaries");
  await mkdir(summariesDir, { recursive: true });

  const files: RepoMemoryFileEntry[] = [];
  const pattern = opts.pattern ?? "src/**/*.{ts,tsx,js,jsx}";

  for await (const f of glob(pattern, { cwd: opts.cwd })) {
    const fullPath = join(opts.cwd, f as string);
    let source: string;
    try {
      source = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const { hash } = await summarizeFile(source, f as string, {
      cacheDir: summariesDir,
      summarize: opts.summarize,
    });
    const lang = (f as string).split(".").pop() ?? "";
    files.push({ path: f as string, sha256: hash, lang, summary_path: `${hash}.md` });
  }

  const conventions = detectConventions(files);
  const index: RepoMemoryIndex = {
    built_at: new Date().toISOString(),
    files,
    conventions,
  };
  await writeFile(join(memoryDir, "index.json"), JSON.stringify(index, null, 2));
  return index;
}

export async function loadIndex(memoryDir = DEFAULT_DIR): Promise<RepoMemoryIndex | null> {
  try {
    const text = await readFile(join(memoryDir, "index.json"), "utf8");
    return JSON.parse(text) as RepoMemoryIndex;
  } catch {
    return null;
  }
}
