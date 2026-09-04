// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { findNearestTsconfig } from "../capabilities";
import type { ProjectCapabilities } from "../capabilities";
import { runTsc } from "./run-tsc";
import { runEslint } from "./run-eslint";
import { runGitDiff } from "./run-git-diff";
import { runRipgrep } from "./run-ripgrep";
import { runWebSearch } from "./run-websearch";
import type { WebSearchClient } from "./run-websearch";
import type { ToolName, ToolResult } from "./types";
import { scanSecrets } from "../security/secrets-scan";
import { scanTaint } from "../security/taint-scan";
import { collectOwaspHints } from "../security/owasp-hints";
import type { RubricTrigger } from "../rubric/types";
import type { OwaspHint } from "../security/owasp-hints";
import { readFileSync } from "node:fs";
import { shouldInvokeWebSearch } from "../../config/websearch";
import type { WebSearchConfig } from "../../config/websearch";
import type { WebSource } from "../../brain/schema-v2";
import type { Tracer } from "../../observability/tracer";
import type { TraceStore } from "../../observability/storage";
import type { Span } from "../../observability/types";

export type RunToolsOpts = {
  cwd: string;
  changedFiles: string[];
  caps: ProjectCapabilities;
  /**
   * The unit of work under review, as `<lastReviewedHead>..HEAD` (spec D2).
   *
   * When present, git-diff shows that range instead of the working tree, which
   * is what makes AC2/AC4 structural rather than parsed-around: the caller
   * names the boundary, so the reviewer can no longer be handed an
   * undelimited multi-commit blob with one commit's message on top of it.
   *
   * Absent for callers with no unit to name — a forced `/siltpoke-review` on a
   * clean tree, and every test that predates the review-unit axis. Those keep
   * the old `git diff HEAD` behaviour.
   */
  revisionRange?: string;
  timeoutsMs?: Partial<Record<ToolName, number>>;
  webSearch?: {
    config?: WebSearchConfig;
    promptOrCritique?: string;
    confidence?: "low" | "med" | "high";
    dailyUsageCount?: number;
    client?: WebSearchClient;
  };
  /**
   * Optional tracing context. When all three are provided, each individual
   * tool invocation emits its own child span with args + result captured.
   * Back-compat: when absent, no spans are emitted.
   */
  tracing?: {
    tracer: Tracer;
    traceStore: TraceStore;
    parentSpan: Span;
  };
};

export type RunToolsResult = Record<ToolName, ToolResult> & {
  securityFindings: RubricTrigger[];
  owaspHints: OwaspHint[];
  webSearchSources: WebSource[];
};

const DEFAULT_TIMEOUTS: Record<ToolName, number> = {
  tsc: 30_000,
  eslint: 15_000,
  "git-diff": 10_000,
  ripgrep: 10_000,
};

// Extensions that trigger tsc / eslint
const TSC_EXTENSIONS = new Set([".ts", ".tsx"]);
const ESLINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function hasExtension(files: string[], extensions: Set<string>): boolean {
  return files.some((f) => {
    const dot = f.lastIndexOf(".");
    if (dot === -1) return false;
    return extensions.has(f.slice(dot));
  });
}

function notApplicable(tool: "tsc"): Extract<ToolResult, { tool: "tsc" }>;
function notApplicable(tool: "eslint"): Extract<ToolResult, { tool: "eslint" }>;
function notApplicable(tool: "git-diff"): Extract<ToolResult, { tool: "git-diff" }>;
function notApplicable(tool: "ripgrep"): Extract<ToolResult, { tool: "ripgrep" }>;
function notApplicable(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "not_applicable", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
    case "git-diff":
      return { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" };
    case "ripgrep":
      return { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" };
  }
}

// ---------------------------------------------------------------------------
// Tracing helper — wrap a single tool invocation in a child span.
// Silent no-op when tracing context is absent (back-compat).
// ---------------------------------------------------------------------------

async function withToolSpan<T extends ToolResult>(
  toolName: ToolName,
  args: Record<string, unknown>,
  tracing: RunToolsOpts["tracing"] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!tracing) return run();

  const { tracer, traceStore, parentSpan } = tracing;
  const span = tracer.startSpan({
    name: `siltpoke.tool.${toolName}`,
    kind: "INTERNAL",
    parent: parentSpan,
  });
  tracer.setKind(span, "tool");
  tracer.setAttribute(span, "siltpoke.tool.name", toolName);
  tracer.setInput(span, args);

  const start = Date.now();
  let result: T;
  try {
    result = await run();
    tracer.setAttribute(span, "siltpoke.tool.status", result.status);
    tracer.setAttribute(span, "siltpoke.tool.duration_ms", Date.now() - start);
    tracer.setOutput(span, result);
    tracer.endSpan(span, { status: result.status === "ok" ? "OK" : "ERROR" });
  } catch (err) {
    tracer.setAttribute(span, "siltpoke.tool.duration_ms", Date.now() - start);
    tracer.endSpan(span, { status: "ERROR", message: String(err) });
    await traceStore.writeSpan(span).catch(() => undefined);
    throw err;
  }
  await traceStore.writeSpan(span).catch(() => undefined);
  return result;
}

export async function runTools(opts: RunToolsOpts): Promise<RunToolsResult> {
  const { cwd, changedFiles, caps, revisionRange, timeoutsMs = {}, webSearch, tracing } = opts;

  const timeouts: Record<ToolName, number> = {
    tsc: timeoutsMs.tsc ?? DEFAULT_TIMEOUTS.tsc,
    eslint: timeoutsMs.eslint ?? DEFAULT_TIMEOUTS.eslint,
    "git-diff": timeoutsMs["git-diff"] ?? DEFAULT_TIMEOUTS["git-diff"],
    ripgrep: timeoutsMs.ripgrep ?? DEFAULT_TIMEOUTS.ripgrep,
  };

  // --- tsc scheduling ---
  const hasTsFiles = hasExtension(changedFiles, TSC_EXTENSIONS);
  const tsconfigPath =
    changedFiles.length > 0
      ? findNearestTsconfig(changedFiles[0]!, caps) ?? (caps.tsconfigPaths[0] ?? null)
      : caps.tsconfigPaths[0] ?? null;

  const shouldRunTsc = hasTsFiles && caps.hasTsc && tsconfigPath !== null;

  // --- eslint scheduling ---
  const eslintFiles = changedFiles.filter((f) => {
    const dot = f.lastIndexOf(".");
    if (dot === -1) return false;
    return ESLINT_EXTENSIONS.has(f.slice(dot));
  });
  // `hasEslint` only means the binary can be spawned, and `bunx eslint
  // --version` succeeds in any directory because bunx fetches it on demand — so
  // on its own that flag is very nearly a constant `true`. Scheduling on it
  // alone made eslint exit 2 ("couldn't find an eslint.config.(js|mjs|cjs)
  // file") in every repo that lints with something else: 3,063 `error` results
  // against 33 `ok` over 85 days of telemetry, siltpoke's own Biome-linted repo
  // included. `eslintConfigPaths` already distinguishes the two cases and was
  // read nowhere; tsc's line above has carried the same guard from the start.
  const shouldRunEslint =
    caps.hasEslint && caps.eslintConfigPaths.length > 0 && eslintFiles.length > 0;

  // --- git-diff: always if git available ---
  const shouldRunGitDiff = caps.hasGit;

  // --- ripgrep: always (assume available; ENOENT → status:not_installed at runtime) ---
  const shouldRunRipgrep = true;

  // Build promises for scheduled tools
  type ResultEntry = [ToolName, ToolResult];

  const promises: Promise<ResultEntry>[] = [];

  if (shouldRunTsc && tsconfigPath !== null) {
    const tscArgs = { cwd, tsconfigPath, timeoutMs: timeouts.tsc };
    promises.push(
      withToolSpan("tsc", tscArgs as Record<string, unknown>, tracing, () =>
        runTsc(tscArgs),
      ).then((r): ResultEntry => ["tsc", r]),
    );
  }

  if (shouldRunEslint) {
    const eslintArgs = { cwd, changedFiles: eslintFiles, timeoutMs: timeouts.eslint };
    promises.push(
      withToolSpan("eslint", eslintArgs as Record<string, unknown>, tracing, () =>
        runEslint(eslintArgs),
      ).then((r): ResultEntry => ["eslint", r]),
    );
  }

  if (shouldRunGitDiff) {
    // `revisionRange` is spread in only when present so the span attributes
    // (and the arg object runGitDiff validates) stay byte-identical to before
    // for every caller that has no unit to name.
    const gitDiffArgs = {
      cwd,
      timeoutMs: timeouts["git-diff"],
      ...(revisionRange !== undefined ? { revisionRange } : {}),
    };
    promises.push(
      withToolSpan("git-diff", gitDiffArgs as Record<string, unknown>, tracing, () =>
        runGitDiff(gitDiffArgs),
      ).then((r): ResultEntry => ["git-diff", r]),
    );
  }

  if (shouldRunRipgrep) {
    const ripgrepArgs = { cwd, timeoutMs: timeouts.ripgrep };
    promises.push(
      withToolSpan("ripgrep", ripgrepArgs as Record<string, unknown>, tracing, () =>
        runRipgrep(ripgrepArgs),
      ).then((r): ResultEntry => ["ripgrep", r]),
    );
  }

  // Run all scheduled tools in parallel
  const settled = await Promise.all(promises);

  // Build result record, filling not_applicable for unscheduled tools
  const resultMap = new Map<ToolName, ToolResult>(settled);

  // --- Security scans (synchronous, run after tool results) ---
  const securityFindings: RubricTrigger[] = [];

  // Secrets scan: scan added lines from each changed file
  for (const file of changedFiles) {
    try {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      const addedLines = lines.map((text, idx) => ({ line: idx + 1, text }));
      const findings = scanSecrets({ file, addedLines });
      securityFindings.push(...findings);
    } catch {
      // File unreadable (deleted, binary, etc.) — skip
    }
  }

  // Taint scan: scan each changed file for untrusted source→sink flows
  for (const file of changedFiles) {
    try {
      const source = readFileSync(file, "utf8");
      const findings = scanTaint({ file, source });
      securityFindings.push(...findings);
    } catch {
      // File unreadable — skip
    }
  }

  // OWASP hints: file-path pattern analysis
  const owaspHints = collectOwaspHints(changedFiles);

  // --- Web search (gated) ---
  let webSearchSources: WebSource[] = [];
  if (webSearch) {
    const wsConfig: WebSearchConfig = webSearch.config ?? { mode: "off", dailyCap: 20 };
    const gate = shouldInvokeWebSearch({
      config: wsConfig,
      promptOrCritique: webSearch.promptOrCritique ?? "",
      confidence: webSearch.confidence ?? "high",
      dailyUsageCount: webSearch.dailyUsageCount ?? 0,
    });
    if (gate && webSearch.promptOrCritique) {
      const result = await runWebSearch(
        { query: webSearch.promptOrCritique, maxResults: 3 },
        { client: webSearch.client },
      );
      webSearchSources = result.sources;
    }
  }

  return {
    tsc: resultMap.get("tsc") ?? notApplicable("tsc"),
    eslint: resultMap.get("eslint") ?? notApplicable("eslint"),
    "git-diff": resultMap.get("git-diff") ?? notApplicable("git-diff"),
    ripgrep: resultMap.get("ripgrep") ?? notApplicable("ripgrep"),
    securityFindings,
    owaspHints,
    webSearchSources,
  };
}
