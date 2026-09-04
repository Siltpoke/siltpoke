// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

export type SupportedLang = "ts" | "tsx" | "js" | "jsx" | "py";

/**
 * Where the tree-sitter .wasm files live, in priority order:
 *   1. SILTPOKE_WASM_DIR       — explicit override (tests, odd installs)
 *   2. <moduleDir>/wasm        — the SHIPPED PLUGIN layout: the bundle sits at
 *                                dist/siltpoke-stop.js, the wasm at dist/wasm/.
 *                                `bun build` rewrites import.meta.url to the
 *                                bundle's own path, so moduleDir === dist/.
 *   3. <moduleDir>/../../../../node_modules  — the DEV repo layout (source run,
 *                                where this file is src/critic/rubric/tier2/).
 *
 * Pure so it can be tested without a filesystem.
 */
export function resolveWasmDir(env: NodeJS.ProcessEnv, moduleDir: string): string {
  const override = env.SILTPOKE_WASM_DIR;
  if (override) return override;
  // In the plugin, moduleDir is dist/ and dist/wasm/ is the only thing there.
  // In the dev repo, dist/wasm does not exist and the node_modules path does —
  // but both are just path strings; the *load* below is what actually decides,
  // and it falls back on failure. Prefer the plugin layout, then dev.
  return join(moduleDir, "wasm");
}

function devWasmDir(moduleDir: string): string {
  return resolve(moduleDir, "../../../../node_modules");
}

// Only reached on the default (no-override) path — both call sites special-case
// and return before calling this when SILTPOKE_WASM_DIR is set, so this always
// tries the plugin-layout guess first, then the dev node_modules path.
function wasmDirs(env: NodeJS.ProcessEnv, moduleDir: string): string[] {
  return [resolveWasmDir(env, moduleDir), devWasmDir(moduleDir)];
}

// initialized/initFailed/langCache are process-wide singletons — correct for
// the real process, which only ever runs one env. They must only ever reflect
// the DEFAULT (no-override) resolution: an explicit SILTPOKE_WASM_DIR probe
// (tests, odd installs) always runs fresh and never reads or writes them,
// so a bogus test override can neither be masked by a prior real init nor
// poison later default-path calls in the same process.
let initialized = false;
let initFailed = false;
const langCache = new Map<SupportedLang, Language>();

const WASM_FILES: Record<SupportedLang, string> = {
  ts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  js: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  jsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  py: "tree-sitter-python/tree-sitter-python.wasm",
};

// In the plugin the wasm files are FLAT in dist/wasm/, in the dev repo they sit
// under their package dirs in node_modules/. Try the flat name first.
function candidatePaths(dir: string, rel: string): string[] {
  const flat = rel.split("/").pop() as string;
  return [join(dir, flat), join(dir, rel)];
}

async function tryInitAt(dir: string): Promise<boolean> {
  for (const candidate of candidatePaths(dir, "web-tree-sitter/web-tree-sitter.wasm")) {
    try {
      await Parser.init({ locateFile: () => candidate });
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

async function ensureInit(env: NodeJS.ProcessEnv, moduleDir: string): Promise<boolean> {
  if (env.SILTPOKE_WASM_DIR) return tryInitAt(env.SILTPOKE_WASM_DIR);
  if (initialized) return true;
  if (initFailed) return false;
  for (const dir of wasmDirs(env, moduleDir)) {
    if (await tryInitAt(dir)) {
      initialized = true;
      return true;
    }
  }
  // No wasm anywhere: tier-2 AST rules are simply unavailable. NEVER throw —
  // a missing wasm must not take down the user's Stop hook.
  initFailed = true;
  return false;
}

async function loadLanguageAt(dir: string, rel: string): Promise<Language | null> {
  for (const candidate of candidatePaths(dir, rel)) {
    try {
      return await Language.load(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function getLanguage(
  lang: SupportedLang,
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<Language | null> {
  if (!(await ensureInit(env, moduleDir))) return null;
  const rel = WASM_FILES[lang];
  if (!rel) return null;

  if (env.SILTPOKE_WASM_DIR) {
    // Explicit override: always a fresh, uncached probe.
    return loadLanguageAt(env.SILTPOKE_WASM_DIR, rel);
  }

  const cached = langCache.get(lang);
  if (cached) return cached;
  for (const dir of wasmDirs(env, moduleDir)) {
    const language = await loadLanguageAt(dir, rel);
    if (language) {
      langCache.set(lang, language);
      return language;
    }
  }
  return null;
}

export async function parseSource(
  source: string,
  lang: SupportedLang,
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<Tree | null> {
  const language = await getLanguage(lang, env, moduleDir);
  if (!language) return null;
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser.parse(source);
  } catch {
    // NEVER throw — a parser-level failure (incompatible cached Language,
    // pathological input, etc.) must degrade to "AST unavailable", not take
    // down the user's Stop hook.
    return null;
  }
}
