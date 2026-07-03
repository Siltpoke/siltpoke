// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { BrainOutputV2 } from "../../brain/schema-v2";
import { callOllama } from "./ollama-client";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface BiasAuditConfig {
  enabled: boolean;
  samplePercent: number;
  model: string;
}

export function shouldSample(cfg: BiasAuditConfig): boolean {
  return cfg.enabled && Math.random() * 100 < cfg.samplePercent;
}

export function dispatchBiasAudit(
  cfg: BiasAuditConfig,
  haikuVerdict: BrainOutputV2,
  promptContext: { system: string; user: string },
): void {
  if (!cfg.enabled) return;
  setImmediate(async () => {
    try {
      const ollamaVerdict = await callOllama(cfg.model, promptContext);
      if (!ollamaVerdict) return;
      const day = new Date().toISOString().slice(0, 10);
      const dir = join(homedir(), ".siltpoke", "bias-audit");
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, `${day}.jsonl`), `${JSON.stringify({
        ts: new Date().toISOString(),
        haiku: { severity: haikuVerdict.severity, confidence: haikuVerdict.confidence, category: haikuVerdict.category },
        ollama: { severity: ollamaVerdict.severity, confidence: ollamaVerdict.confidence, category: ollamaVerdict.category },
      })}\n`);
    } catch {
      // silent
    }
  });
}
