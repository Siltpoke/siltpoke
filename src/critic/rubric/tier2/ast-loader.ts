// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Tree } from "web-tree-sitter";

export type SupportedLang = "ts" | "tsx" | "js" | "jsx" | "py";

// Resolve wasm relative to this module (the siltpoke install), not the
// caller's cwd — the CLI runs with cwd set to the project being indexed,
// which has no node_modules of ours.
const NODE_MODULES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules",
);

let initialized = false;
const langCache = new Map<SupportedLang, Language>();

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await Parser.init({
    locateFile: () => `${NODE_MODULES}/web-tree-sitter/web-tree-sitter.wasm`,
  });
  initialized = true;
}

const WASM_PATHS: Record<SupportedLang, string> = {
  ts: `${NODE_MODULES}/tree-sitter-typescript/tree-sitter-typescript.wasm`,
  tsx: `${NODE_MODULES}/tree-sitter-typescript/tree-sitter-tsx.wasm`,
  js: `${NODE_MODULES}/tree-sitter-typescript/tree-sitter-typescript.wasm`,
  jsx: `${NODE_MODULES}/tree-sitter-typescript/tree-sitter-tsx.wasm`,
  py: `${NODE_MODULES}/tree-sitter-python/tree-sitter-python.wasm`,
};

export async function getLanguage(lang: SupportedLang): Promise<Language | null> {
  await ensureInit();
  const cached = langCache.get(lang);
  if (cached) return cached;
  const wasmPath = WASM_PATHS[lang];
  if (!wasmPath) return null;
  try {
    const language = await Language.load(wasmPath);
    langCache.set(lang, language);
    return language;
  } catch {
    return null;
  }
}

export async function parseSource(
  source: string,
  lang: SupportedLang,
): Promise<Tree | null> {
  const language = await getLanguage(lang);
  if (!language) return null;
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}
