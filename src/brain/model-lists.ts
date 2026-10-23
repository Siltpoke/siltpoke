// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every agent's own model list, read from its own CLI (spec §11.3, §12.5) —
 * what the Settings page's "Change model" window lists.
 *
 *   agy        `agy models`             `id TAB display name` per line
 *   qoder      `qodercli --list-models` one id per line under a `MODEL` header
 *   codex      `codex debug models`     JSON `models[]`; only `visibility: "list"`
 *   codebuddy  `codebuddy --help`       the `--model` line's `Currently supported: (a, b, …)`
 *   claude     no list command          the hand list in registry.ts, dated below
 *
 * The lists are saved to `<home>/model-lists.json` so the window opens on the
 * last good copy at once and refreshes behind it. A failed refresh keeps the
 * saved entries and records why (`error`): an empty window because one CLI was
 * slow would read as "this agent has no models".
 *
 * Tiers: qoder and codebuddy also list names of their own that are not public
 * models (spec §12.5). They are marked `tier: true`; nothing can be looked up
 * for them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { FAMILIES, type ProviderFamily } from "./brain-config";
import { drainProcess, stopProcess } from "./drain-process";
import { CLAUDE_REVIEW_MODELS } from "./registry";

export interface ModelEntry {
  id: string;
  family: ProviderFamily;
  /** The CLI's own words for it (agy's display name, codex's description). */
  description: string | null;
  /** One of the agent's own tier names, not a public model. */
  tier: boolean;
}

export interface FamilyModelList {
  entries: ModelEntry[];
  /** Why the last refresh failed; null when it worked or never ran. */
  error: string | null;
  /** When `entries` was fetched (ISO); null = never. */
  fetchedAt: string | null;
}

export interface ModelLists {
  /** The newest `fetchedAt` across the CLI families; null = none fetched. */
  fetchedAt: string | null;
  families: Record<ProviderFamily, FamilyModelList>;
}

/** The day the claude hand list was last checked against Anthropic's model list. */
export const CLAUDE_MODELS_AS_OF = "2026-10-14";

const TIERS: Partial<Record<ProviderFamily, readonly string[]>> = {
  qoder: ["Auto", "Efficient", "Performance", "Ultimate"],
  codebuddy: [
    "default-model",
    "fast-model",
    "balanced-model",
    "primary-model",
    "deep-model",
    "hy4-preview",
    "hy3",
  ],
};

/** The command that prints each CLI family's list. claude has none. */
export const LIST_COMMAND: Record<Exclude<ProviderFamily, "claude">, string[]> = {
  agy: ["agy", "models"],
  qoder: ["qodercli", "--list-models"],
  codex: ["codex", "debug", "models"],
  codebuddy: ["codebuddy", "--help"],
};

const CACHE = "model-lists.json";
const TIMEOUT_MS = 10_000;
const TIMEOUT_LABEL = "no answer in 10s";

function entry(family: ProviderFamily, id: string, description: string | null = null): ModelEntry {
  return { id, family, description, tier: TIERS[family]?.includes(id) ?? false };
}

function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l.length > 0);
}

/** Parse one CLI's output. Output in an unexpected shape gives [], never a throw. */
export function parseModelList(family: ProviderFamily, stdout: string): ModelEntry[] {
  try {
    switch (family) {
      case "agy":
        return lines(stdout)
          .filter((l) => l.includes("\t"))
          .map((l) => {
            const [id, name] = l.split("\t");
            return entry("agy", (id ?? "").trim(), name?.trim() || null);
          })
          .filter((e) => e.id.length > 0);
      case "qoder":
        return lines(stdout)
          .filter((l) => l !== "MODEL" && !/\s/.test(l))
          .map((l) => entry("qoder", l));
      case "codex": {
        const parsed = JSON.parse(stdout) as { models?: unknown };
        if (!Array.isArray(parsed.models)) return [];
        return parsed.models
          .filter(
            (m): m is { slug: string; description?: unknown } =>
              typeof m === "object" &&
              m !== null &&
              (m as { visibility?: unknown }).visibility === "list" &&
              typeof (m as { slug?: unknown }).slug === "string",
          )
          .map((m) => entry("codex", m.slug, typeof m.description === "string" ? m.description : null));
      }
      case "codebuddy": {
        const match = /Currently supported:\s*\(([^)]*)\)/.exec(stdout);
        if (match === null) return [];
        return (match[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => entry("codebuddy", s));
      }
      case "claude":
        return CLAUDE_REVIEW_MODELS.map((id) => entry("claude", id));
    }
  } catch {
    return [];
  }
}

const NEVER: FamilyModelList = { entries: [], error: null, fetchedAt: null };

function claudeList(): FamilyModelList {
  return { entries: parseModelList("claude", ""), error: null, fetchedAt: CLAUDE_MODELS_AS_OF };
}

function readCache(home: string): Partial<Record<ProviderFamily, FamilyModelList>> {
  const path = join(home, CACHE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { families?: unknown };
    return parsed.families && typeof parsed.families === "object"
      ? (parsed.families as Partial<Record<ProviderFamily, FamilyModelList>>)
      : {};
  } catch {
    return {};
  }
}

function withNewest(families: Record<ProviderFamily, FamilyModelList>): ModelLists {
  const dates = FAMILIES.filter((f) => f !== "claude")
    .map((f) => families[f].fetchedAt)
    .filter((d): d is string => d !== null)
    .sort();
  return { fetchedAt: dates.at(-1) ?? null, families };
}

export function readModelLists(home: string): ModelLists {
  const cached = readCache(home);
  const families = {} as Record<ProviderFamily, FamilyModelList>;
  for (const f of FAMILIES) {
    families[f] = f === "claude" ? claudeList() : (cached[f] ?? NEVER);
  }
  return withNewest(families);
}

/** Runs one CLI. Production: `defaultRunner`; tests inject one. */
export type ModelListRunner = (argv: string[], timeoutMs: number) => Promise<{ stdout: string; code: number | null }>;

export const defaultRunner: ModelListRunner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  // [51] follow-up: stop for good on timeout, and stop reading once the CLI has
  // exited — a child of it holding stdout used to hold the refresh.
  const timer = setTimeout(() => {
    try {
      stopProcess(proc);
    } catch {
      // already gone
    }
  }, timeoutMs);
  try {
    const { stdout, exitCode } = await drainProcess(proc);
    return { stdout, code: exitCode };
  } finally {
    clearTimeout(timer);
  }
};

const TIMED_OUT = Symbol("timeout");

/** Fetch one family's list. The previous list stays when this fails. */
async function fetchOne(
  family: Exclude<ProviderFamily, "claude">,
  prior: FamilyModelList,
  run: ModelListRunner,
  now: Date,
  timeoutMs: number,
): Promise<FamilyModelList> {
  const keep = (error: string): FamilyModelList => ({ ...prior, error });
  let result: { stdout: string; code: number | null } | typeof TIMED_OUT;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((r) => {
      timer = setTimeout(() => r(TIMED_OUT), timeoutMs);
    });
    result = await Promise.race([run(LIST_COMMAND[family], timeoutMs), timeout]);
    clearTimeout(timer);
  } catch {
    return keep(`could not run ${LIST_COMMAND[family][0]}`);
  }
  if (result === TIMED_OUT) return keep(TIMEOUT_LABEL);
  const entries = parseModelList(family, result.stdout);
  if (entries.length === 0) {
    return keep(
      result.code !== 0 ? `${LIST_COMMAND[family][0]} failed (exit ${result.code})` : "no models in its answer",
    );
  }
  return { entries, error: null, fetchedAt: now.toISOString() };
}

/**
 * Refresh the given CLI families at once and save them in ONE write, so two
 * refreshes landing together cannot drop each other's list.
 */
export async function refreshModelLists(
  home: string,
  families: readonly ProviderFamily[] = FAMILIES,
  run: ModelListRunner = defaultRunner,
  now: Date = new Date(),
  timeoutMs: number = TIMEOUT_MS,
): Promise<ModelLists> {
  const current = readModelLists(home);
  const targets = families.filter((f): f is Exclude<ProviderFamily, "claude"> => f !== "claude");
  const fresh = await Promise.all(targets.map((f) => fetchOne(f, current.families[f], run, now, timeoutMs)));
  // Re-read just before writing: a refresh that finished while this one ran
  // keeps the families it wrote.
  const saved = { ...readCache(home), ...Object.fromEntries(targets.map((f, i) => [f, fresh[i]])) };
  atomicWrite(join(home, CACHE), `${JSON.stringify({ families: saved }, null, 1)}\n`);
  return readModelLists(home);
}

/** One family — the shape the tests drive. */
export function refreshModelList(
  home: string,
  family: ProviderFamily,
  run: ModelListRunner = defaultRunner,
  now: Date = new Date(),
  timeoutMs: number = TIMEOUT_MS,
): Promise<ModelLists> {
  return refreshModelLists(home, [family], run, now, timeoutMs);
}
