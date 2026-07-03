// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { exec } from "node:child_process";
const execp = promisify(exec);

const MODEL = "qwen2.5-coder:7b-instruct-q4_K_M";

export async function checkOllamaInstalled(
  deps: { which?: (bin: string) => Promise<string | null> } = {},
): Promise<boolean> {
  const which = deps.which ?? (async (bin: string) => {
    try { const { stdout } = await execp(`which ${bin}`); return stdout.trim() || null; }
    catch { return null; }
  });
  return (await which("ollama")) !== null;
}

export async function pullModel(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("ollama", ["pull", MODEL], { stdio: "inherit" });
    p.on("exit", code => code === 0 ? resolve() : reject(new Error(`pull exited ${code}`)));
  });
}

export async function validateModel(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt: "Say 'ok' in one word.", stream: false }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface OllamaIo {
  write: (s: string) => void;
}

export interface OllamaDeps {
  checkInstalled?: () => Promise<boolean>;
  pull?: () => Promise<void>;
  validate?: () => Promise<boolean>;
}

export async function setupOllamaInteractive(
  opts: { skip?: boolean; io?: OllamaIo; deps?: OllamaDeps } = {},
): Promise<{ enabled: boolean }> {
  if (opts.skip) return { enabled: false };
  const io = opts.io ?? { write: (s: string) => void process.stdout.write(s) };
  const checkInstalled = opts.deps?.checkInstalled ?? (() => checkOllamaInstalled());
  const pull = opts.deps?.pull ?? pullModel;
  const validate = opts.deps?.validate ?? validateModel;

  const installed = await checkInstalled();
  if (!installed) {
    return { enabled: false };
  }
  // sq-ollama-silent-pull (day-1): the pull streams Ollama's own progress bar
  // (pullModel uses stdio:"inherit"), but with no heads-up the user faces a
  // sudden multi-minute, multi-GB download with zero context. Announce it so
  // the wait is understood, not mistaken for a hang.
  io.write(
    `\n⏳ Pulling local bias-audit model ${MODEL} (one-time, several GB — this can take a few minutes)...\n`,
  );
  try {
    await pull();
  } catch (e) {
    console.warn("Pull failed; bias audit disabled.", e);
    return { enabled: false };
  }
  const ok = await validate();
  if (!ok) {
    console.warn("Model pulled but validation failed; bias audit will be disabled.");
    return { enabled: false };
  }
  // Only announce readiness once the model is pulled AND validated — otherwise
  // a validation failure would follow a premature "ready" line.
  io.write("✓ Local model ready.\n");
  return { enabled: true };
}

export const OLLAMA_MODEL = MODEL;
