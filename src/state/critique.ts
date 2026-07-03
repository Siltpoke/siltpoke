// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { BrainOutput } from "../brain/schema";

export interface CritiqueInput {
  brain_output: BrainOutput;
  session_id: string;
  cwd: string;
}

export interface CritiqueResult {
  id: string;
  path: string;
}

function shortId(): string {
  return `c-${randomBytes(2).toString("hex")}`;
}

function todayDir(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeForFence(text: string): string {
  // Find any existing run of backticks and use a fence one longer than
  // the longest run, so the body can never close our fence early.
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function buildMarkdown(input: CritiqueInput, id: string): string {
  const out = input.brain_output;
  const timestamp = new Date().toISOString();
  const project = input.cwd ? basename(input.cwd) : "";
  const fence = escapeForFence(out.critique_for_claude);

  const frontmatter = [
    "---",
    `schemaVersion: 1`,
    `timestamp: ${timestamp}`,
    `critique_id: ${id}`,
    `session_id: ${input.session_id}`,
    `cwd: ${input.cwd}`,
    `project: ${project}`,
    `mood: ${out.mood}`,
    `pose: ${out.pose}`,
    `severity: ${out.severity}`,
    `confidence: ${out.confidence}`,
    `status: pending`,
    "---",
  ].join("\n");

  const body = [
    "",
    "# [SILTPOKE CRITIQUE]",
    "",
    "> ⚠️ This is a secondary AI reviewer's opinion from Siltpoke, a buddy assistant.",
    "> It MAY BE WRONG. Verify against the actual code before acting on this feedback.",
    "> Your primary source of truth is the user and the codebase itself.",
    "",
    "## Bubble (user-facing)",
    "",
    out.bubble_short,
  ];
  if (out.bubble_long) {
    body.push("", out.bubble_long);
  }
  body.push(
    "",
    "## Critique (for Claude, if forwarded)",
    "",
    fence,
    out.critique_for_claude,
    fence,
    "",
    "## Severity / Confidence",
    "",
    `severity: ${out.severity}`,
    `confidence: ${out.confidence}`,
    "",
  );

  return `${frontmatter}\n${body.join("\n")}`;
}

export async function writeCritique(
  basePath: string,
  input: CritiqueInput,
): Promise<CritiqueResult> {
  const id = shortId();
  const dateDir = todayDir();
  const archiveDir = join(basePath, "critiques", "archive", dateDir);
  const filename = `${id}.md`;
  const fullPath = join(archiveDir, filename);
  const historyPath = join(basePath, "critiques", "history.jsonl");
  const latestPath = join(basePath, "critiques", "latest.md");
  const md = buildMarkdown(input, id);

  try {
    await mkdir(archiveDir, { recursive: true });
    await writeFile(fullPath, md, "utf8");
  } catch {
    return { id, path: fullPath };
  }

  try {
    const historyLine =
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        critique_id: id,
        session_id: input.session_id,
        cwd: input.cwd,
        mood: input.brain_output.mood,
        severity: input.brain_output.severity,
        confidence: input.brain_output.confidence,
        bubble_short: input.brain_output.bubble_short,
        path: fullPath,
      })}\n`;
    await appendFile(historyPath, historyLine);
  } catch {
    // history append failure is non-fatal
  }

  try {
    await copyFile(fullPath, latestPath);
  } catch {
    // latest copy failure is non-fatal
  }

  return { id, path: fullPath };
}
