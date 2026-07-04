// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * OllamaVerdict — the fields we ask Qwen to return for bias comparison.
 *
 * NOTE: Ollama is prompted to use abbreviated values ("med" instead of "medium")
 * since that is the format specified in the system prompt to the model. The
 * values here are raw LLM strings, not validated against BrainOutputV2 enums.
 * Delta computation compares them as plain strings (haiku.severity === ollama.severity).
 */
export interface OllamaVerdict {
  severity: string;
  confidence: string;
  category: string;
  reasoning: string;
}

export async function callOllama(
  model: string,
  ctx: { system: string; user: string },
  opts: { endpoint?: string; timeoutMs?: number } = {},
): Promise<OllamaVerdict | null> {
  const endpoint = opts.endpoint ?? "http://localhost:11434/api/generate";
  const timeout = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `${ctx.system}\n\n${ctx.user}\n\nRespond with JSON only: { "severity": "info|low|med|high|critical", "confidence": "low|med|high", "category": "correctness|security|design|tests|readability|performance|consistency", "reasoning": "<one sentence>" }`,
        stream: false,
        format: "json",
      }),
    });
    if (!r.ok) return null;
    const data = await r.json() as { response?: string };
    if (!data.response) return null;
    const parsed = JSON.parse(data.response) as OllamaVerdict;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
