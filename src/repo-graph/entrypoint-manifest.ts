import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryIndex } from "./types";

export interface Manifest { name?: string; bin: Record<string, string>; scripts: Record<string, string> }

export function readManifest(repoRoot: string): Manifest | null {
  let raw: string;
  try { raw = readFileSync(join(repoRoot, "package.json"), "utf8"); } catch { return null; }
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(raw); } catch { return null; }
  const name = typeof pkg.name === "string" ? pkg.name : undefined;
  let bin: Record<string, string> = {};
  if (typeof pkg.bin === "string") {
    const key = name ? name.split("/").pop()! : pkg.bin.replace(/^\.\//, "").replace(FILE_RE, "").split("/").pop()!;
    bin = { [key]: pkg.bin };
  } else if (pkg.bin && typeof pkg.bin === "object") {
    for (const [k, v] of Object.entries(pkg.bin)) if (typeof v === "string") bin[k] = v;
  }
  const scripts: Record<string, string> = {};
  if (pkg.scripts && typeof pkg.scripts === "object") {
    for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === "string") scripts[k] = v;
  }
  return { name, bin, scripts };
}

const RUNNERS = new Set(["node", "tsx", "ts-node", "bun"]);
const FILE_RE = /\.(ts|tsx|js|mjs|cjs)$/;

export function parseScriptEntry(command: string): string | null {
  if (/[&|;]/.test(command)) return null; // chains/opaque → skip
  const toks = command.trim().split(/\s+/);
  if (toks.length === 0) return null;
  const head = toks[0]!;
  if (head.startsWith("./") && FILE_RE.test(head)) return head;
  if (!RUNNERS.has(head) && !(head === "bun" && toks[1] === "run")) return null;
  // skip runner + `run` + any -flag/preload token; first remaining positional that looks like a file
  const rest = (head === "bun" && toks[1] === "run") ? toks.slice(2) : toks.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith("-")) { i++; continue; } // flag consumes its value (e.g. -r dotenv/config)
    if (FILE_RE.test(t) || t.startsWith("./")) return t;
    return null; // first positional is not a file (e.g. `next`) → opaque
  }
  return null;
}

export interface FileResolution { filePath: string; resolvedBy: "direct" | "remap" }
const SRC_EXTS = [".ts", ".tsx", ".mts", ".cts"];
const OUT_DIRS = ["dist/", "build/", "lib/", "out/"];

export function remapToSource(queryIndex: QueryIndex, manifestPath: string, _repoRoot: string): FileResolution | null {
  const norm = manifestPath.replace(/^\.\//, "");
  if (queryIndex.path_to_node_ids[norm]) return { filePath: norm, resolvedBy: "direct" };
  const base = norm.replace(FILE_RE, "");
  const outStripped = OUT_DIRS.reduce((p, d) => (p.startsWith(d) ? "src/" + p.slice(d.length) : p), base);
  const candidates: string[] = [];
  for (const stem of [base, outStripped]) {
    for (const ext of SRC_EXTS) { candidates.push(stem + ext); candidates.push(`${stem}/index${ext}`); }
  }
  const hits = [...new Set(candidates)].filter((c) => queryIndex.path_to_node_ids[c]);
  return hits.length === 1 ? { filePath: hits[0]!, resolvedBy: "remap" } : null;
}
