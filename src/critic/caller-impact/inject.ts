// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Caller-impact orchestrator.
 *
 * Turns a unified diff into a bounded, structural "callers that may break"
 * section the NORMAL critic phase injects into the Brain prompt, plus the
 * discrete quotable tokens the evidence-guard matches verbatim.
 *
 * Robustness: every failure mode — no images, parse failure, resolver
 * unavailable, no signature change — degrades to `{ section: "", tokens: [] }`.
 * The orchestrator never throws; the critic runs normally without a block.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractFile } from "../../repo-graph/extractor.ts";
import { parseSource, type SupportedLang } from "../rubric/tier2/ast-loader.ts";
import { assembleCallerBlock } from "./block-assembler.ts";
import {
  type CallerResolver,
  type CallerSet,
  GrepCallerResolver,
  type ResolveOpts,
} from "./caller-resolver.ts";
import { GraphCallerResolver } from "./caller-resolver-graph.ts";
import {
  type ChangedFunction,
  extractChangedFunctions,
  type ImageReader,
} from "./changed-functions.ts";
import { signatureDelta } from "./signature-delta.ts";

/** Injected seams (default to git-HEAD reader + grep resolver). */
export interface CallerImpactDeps {
  resolver?: CallerResolver;
  images?: ImageReader;
}

export interface CallerImpactResult {
  section: string;
  tokens: string[];
}

/**
 * A resolver that tries the graph first and falls back to grep when the
 * graph is unavailable (no index on disk / load failure). This is what
 * `SILTPOKE_CALLER_RESOLVER=graph` selects, so graph-mode still produces a block
 * on an unindexed repo. Graph being merely *empty* of callers (defs found, zero
 * cross-file callsites) is a real answer, NOT unavailable — only `unavailable`
 * triggers the grep fallback.
 */
export function graphThenGrep(
  graph: CallerResolver,
  grep: CallerResolver,
): CallerResolver {
  return {
    async resolveCallers(name: string, opts: ResolveOpts): Promise<CallerSet> {
      const fromGraph = await graph.resolveCallers(name, opts);
      if (!fromGraph.unavailable) return fromGraph;
      return grep.resolveCallers(name, opts);
    },
  };
}

/**
 * Pick the resolver from `SILTPOKE_CALLER_RESOLVER`. Default (unset / any value
 * other than `graph`) is the user-facing `GrepCallerResolver` — graph is NOT the
 * default. `graph` selects the graph-then-grep wrapper (the graph arm).
 */
export function selectResolver(): CallerResolver {
  if (process.env.SILTPOKE_CALLER_RESOLVER === "graph") {
    return graphThenGrep(new GraphCallerResolver(), new GrepCallerResolver());
  }
  return new GrepCallerResolver();
}

const EMPTY: CallerImpactResult = { section: "", tokens: [] };
const SECTION_HEADER = "## Caller impact (1-hop, structural)";
/** Bound the section so a many-function diff can't blow the prompt budget. */
const MAX_FUNCTIONS = 6;

/** TS-family lang for a cwd-relative path, or null if not a TS-family file. */
function langOf(path: string): SupportedLang | null {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts"))
    return "ts";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs"))
    return "js";
  return null;
}

/** Distinct TS-family langs present among the changed files. */
function langsPresent(changedFiles: string[]): SupportedLang[] {
  const seen = new Set<SupportedLang>();
  for (const f of changedFiles) {
    const l = langOf(f);
    if (l) seen.add(l);
  }
  return [...seen];
}

/**
 * Wrap an ImageReader so it only yields source for files of `lang` — every
 * other file reads as null, so a per-lang `extractChangedFunctions` pass parses
 * only its own files (mixing langs through one parser would mis-parse).
 */
function scopeImagesToLang(images: ImageReader, lang: SupportedLang): ImageReader {
  const gate = (path: string, read: (p: string) => string | null) =>
    langOf(path) === lang ? read(path) : null;
  return {
    pre: (path) => gate(path, images.pre),
    post: (path) => gate(path, images.post),
  };
}

/** Default reader: pre = `git show HEAD:<path>`, post = working-tree file. */
function defaultImageReader(cwd: string): ImageReader {
  return {
    pre: (path) => {
      try {
        const proc = Bun.spawnSync(["git", "show", `HEAD:${path}`], { cwd });
        if (proc.exitCode !== 0) return null;
        return new TextDecoder().decode(proc.stdout);
      } catch {
        return null;
      }
    },
    post: (path) => {
      try {
        return readFileSync(resolve(cwd, path), "utf8");
      } catch {
        return null; // ENOENT (file removed) and any read error degrade to null
      }
    },
  };
}

/** Slice a 1-based inclusive `[start..end]` line range out of a source image. */
function sliceLines(src: string, start: number, end: number): string {
  return src.split("\n").slice(start - 1, end).join("\n");
}

/**
 * The first function with `name`'s 1-based inclusive line range in `src`, or
 * null if the image can't be parsed or has no such function. Mirrors the
 * pre-image re-extract done internally elsewhere (helper not exported).
 */
async function preFnRange(
  src: string | null,
  relPath: string,
  lang: SupportedLang,
  name: string,
): Promise<{ start: number; end: number } | null> {
  if (src === null) return null;
  const tree = await parseSource(src, lang);
  if (!tree) return null;
  const { nodes } = extractFile(tree, {
    relPath,
    lang,
    lineCount: src.split("\n").length,
  });
  for (const n of nodes) {
    if (n.type === "function" && n.name === name) {
      return { start: n.lineRange[0], end: n.lineRange[1] };
    }
  }
  return null;
}

/**
 * For a `modified` function decide whether its SIGNATURE changed by slicing the
 * pre image (re-extracted by name) and post image (its ChangedFunction range)
 * down to the function source and running the signature delta. `skipped`
 * (unparsable) ⇒ false (no block).
 */
async function sigChangedForModified(
  fn: ChangedFunction,
  images: ImageReader,
  lang: SupportedLang,
): Promise<boolean> {
  const postSrcFile = images.post(fn.file);
  const preSrcFile = images.pre(fn.file);
  if (postSrcFile === null || preSrcFile === null) return false;

  const postFnSource = sliceLines(postSrcFile, fn.lineRange.start, fn.lineRange.end);
  const preRange = await preFnRange(preSrcFile, fn.file, lang, fn.name);
  if (!preRange) return false;
  const preFnSource = sliceLines(preSrcFile, preRange.start, preRange.end);

  const delta = await signatureDelta(preFnSource, postFnSource, lang);
  return delta.changed && !delta.skipped;
}

/** Build the caller block for one changed function, or null if none warranted. */
async function blockForFunction(
  fn: ChangedFunction,
  args: { changedFiles: string[]; cwd: string },
  resolver: CallerResolver,
  images: ImageReader,
  lang: SupportedLang,
): Promise<{ text: string; tokens: string[] } | null> {
  if (fn.kind === "added") return null; // assembler returns null anyway

  const signatureChanged =
    fn.kind === "modified"
      ? await sigChangedForModified(fn, images, lang)
      : false; // removed never consults sig-delta

  const callers = await resolver.resolveCallers(fn.name, {
    cwd: args.cwd,
    excludeFiles: args.changedFiles,
  });

  const block = assembleCallerBlock({
    functionName: fn.name,
    kind: fn.kind,
    signatureChanged,
    callers,
  });
  if (!block) return null;
  return { text: block.text, tokens: block.tokens };
}

/** Accumulator threaded through the per-lang collection passes. */
interface BlockAcc {
  texts: string[];
  tokens: string[];
}

/** Collect caller blocks for one lang's changed functions into `acc` (up to the cap). */
async function collectLangBlocks(
  lang: SupportedLang,
  args: { diffBody: string; changedFiles: string[]; cwd: string },
  resolver: CallerResolver,
  images: ImageReader,
  acc: BlockAcc,
): Promise<void> {
  const scoped = scopeImagesToLang(images, lang);
  const changed = await extractChangedFunctions(args.diffBody, scoped, lang);
  for (const fn of changed) {
    if (acc.texts.length >= MAX_FUNCTIONS) return;
    const block = await blockForFunction(fn, args, resolver, scoped, lang);
    if (!block) continue;
    acc.texts.push(block.text);
    acc.tokens.push(...block.tokens);
  }
}

/**
 * Build the caller-impact section + its quotable tokens for a diff.
 *
 * Returns `{ section: "", tokens: [] }` whenever nothing is warranted or any
 * step fails — the critic continues without a block, never with a wrong one.
 */
export async function buildCallerImpactSection(
  args: { diffBody: string; changedFiles: string[]; cwd: string },
  deps?: CallerImpactDeps,
): Promise<CallerImpactResult> {
  if (!args.diffBody.trim()) return EMPTY;
  // Safety net: this single try/catch is what makes the whole pipeline
  // non-throwing. The deeper calls it covers — `parseSource` / `extractFile`
  // (in collectLangBlocks + preFnRange) and `resolver.resolveCallers` — are NOT
  // individually guarded, so a refactor that moves any of them OUT of this scope
  // must re-establish a catch, or one bad parse breaks every NORMAL critic run.
  try {
    const resolver = deps?.resolver ?? selectResolver();
    const images = deps?.images ?? defaultImageReader(args.cwd);
    const acc: BlockAcc = { texts: [], tokens: [] };

    for (const lang of langsPresent(args.changedFiles)) {
      if (acc.texts.length >= MAX_FUNCTIONS) break;
      await collectLangBlocks(lang, args, resolver, images, acc);
    }

    if (acc.texts.length === 0) return EMPTY;
    return { section: [SECTION_HEADER, ...acc.texts].join("\n\n"), tokens: acc.tokens };
  } catch {
    return EMPTY; // any failure degrades to no block, never throws
  }
}
