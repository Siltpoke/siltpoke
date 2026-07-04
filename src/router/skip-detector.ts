// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import {
  readSkipState,
  writeSkipState,
  pruneExpired,
} from "../state/skip-state";

export interface SkipDecision {
  skip: boolean;
  hash: string;
  reason?: "no_change";
}

export interface EvaluateSkipOptions {
  basePath: string;
  sessionId: string;
  signature: string;
}

export interface BuildSignatureInput {
  sessionId: string;
  cwd: string;
  changedFiles: readonly string[];
  latestUserMessage: string;
}

export function buildSignature(input: BuildSignatureInput): string {
  const files = [...input.changedFiles].sort().join("|");
  return [
    `session:${input.sessionId}`,
    `cwd:${input.cwd}`,
    `files:${files}`,
    `user:${input.latestUserMessage.trim()}`,
  ].join("\n");
}

export function computeContextHash(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

export async function evaluateSkip(
  opts: EvaluateSkipOptions,
): Promise<SkipDecision> {
  const hash = computeContextHash(opts.signature);
  const state = await readSkipState(opts.basePath);
  const prior = state.entries[opts.sessionId];
  if (prior && prior.hash === hash) {
    return { skip: true, hash, reason: "no_change" };
  }
  return { skip: false, hash };
}

export async function commitHash(
  basePath: string,
  sessionId: string,
  hash: string,
  now: () => number = Date.now,
): Promise<void> {
  const current = await readSkipState(basePath);
  const pruned = pruneExpired(current, undefined, now());
  pruned.entries[sessionId] = {
    hash,
    updated_at_ms: now(),
  };
  await writeSkipState(basePath, pruned);
}
