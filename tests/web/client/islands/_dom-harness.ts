/** DOM-mount harness for client-island tests.
 *
 * PER-FILE SCOPE ONLY — never wire into bunfig [test] preload: `bun test` runs
 * every file in one process, and GlobalRegistrator.register() swaps
 * globalThis.fetch for happy-dom's node:http fetch (Bun breakage history:
 * oven-sh/bun#8774). A preload would impose DOM globals + a foreign fetch on
 * the 1000+ existing non-DOM tests. Pattern: registerDom() in beforeAll,
 * unregisterDom() in afterAll, all deferreds settled before teardown.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RepoGraphScreenProps } from "../../../../src/web/screens/RepoGraph";

// Captured BEFORE any register() so teardown can reassert Bun-native fetch
// even if unregister()'s own restoration ever regresses.
const realFetch = globalThis.fetch;

export function registerDom(): void {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876/repo-graph" });
}

export async function unregisterDom(): Promise<void> {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

export type FetchRoute = [match: string, handler: (url: string) => Promise<Response>];

/** URL-substring-routed fetch mock. Unmatched routes resolve `{success:true,
 * data:{}}` — resolve-only by design: a reject from a forgotten route would
 * surface as an unhandled rejection blamed on whatever test runs next.
 * Each test MUST call this for a clean route table — there is no restore
 * counterpart; the previous test's mock (and its already-settled deferreds)
 * stays installed until overwritten or unregisterDom() reasserts native. */
export function installFetchMock(routes: FetchRoute[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url);
    }
    return Promise.resolve(jsonResponse({ success: true, data: {} }));
  }) as typeof fetch;
}

// ── Fixture: minimal valid props that land the island on
// archSource === "subset" (repo-graph.ts:415–438): non-empty subdirs +
// proj.repo set (canSubset), non-siltpoke project_root (hasAuthored=false),
// generatedModel null, no ?arch-mode=codemap in the registrator URL.
const FIXTURE_ROOT = "/tmp/island-harness-fixture-repo";
const FIXTURE_HASH = "f1x7ur3hash0";

export function buildFixtureProps(overrides: Partial<RepoGraphScreenProps> = {}): RepoGraphScreenProps {
  const projection = {
    repo: {
      id: FIXTURE_HASH,
      name: "fixture-repo",
      path: FIXTURE_ROOT,
      files: 3,
      symbols: 9,
      edges: 1,
      lastIndexedTs: "2026-06-09T00:00:00.000Z",
      building: false,
      groupingMode: "fallback" as const,
    },
    groups: [{ id: "core", title: "Core", short: "Core", accent: "#d96b6b" }],
    subdirs: [
      {
        id: "alpha",
        group: "core",
        path: "src/alpha/",
        files: 2,
        funcCount: 6,
        recurringBasenames: [],
        purpose: "",
        inbound: 1,
        outbound: 0,
      },
      {
        id: "beta",
        group: "core",
        path: "src/beta/",
        files: 1,
        funcCount: 3,
        recurringBasenames: [],
        purpose: "",
        inbound: 0,
        outbound: 1,
      },
    ],
    edges: [{ source: "beta", target: "alpha", weight: 1 }],
  };
  return {
    projection,
    repoEntries: [
      {
        proj_hash: FIXTURE_HASH,
        project_root: FIXTURE_ROOT,
        last_indexed_ts: "2026-06-09T00:00:00.000Z",
        status: "ready" as const,
      },
    ],
    currentProjHash: FIXTURE_HASH,
    stalenessBanner: null,
    stats: { files: 3, symbols: 9, edges: 1 },
    generatedModel: null,
    ...overrides,
  };
}

/** Mount the island the way the real page does, minus Alpine's pipeline:
 * real RepoGraph.tsx SSR render → real registerRepoGraph export →
 * real factory → real FULL bootRepoGraph body, synchronously. Imports are
 * dynamic so they evaluate AFTER registerDom() (the island's top-level
 * selfRegister() touches document; without globalThis.Alpine it only attaches
 * a never-firing alpine:init listener — benign, kanban.test.ts precedent). */
export async function mountRepoGraph(
  overrides: Partial<RepoGraphScreenProps> = {},
): Promise<HTMLElement> {
  const { RepoGraph } = await import("../../../../src/web/screens/RepoGraph");
  const html = String(RepoGraph(buildFixtureProps(overrides)));
  document.body.innerHTML = html;
  const root = document.querySelector<HTMLElement>('[x-data="repoGraph"]');
  if (!root) throw new Error("fixture missing [x-data=repoGraph] root");

  type Factory = () => { init(this: { $root: HTMLElement }): void };
  let captured: Factory | undefined;
  const fakeAlpine = {
    data: (_name: string, factory: Factory) => {
      captured = factory;
    },
  };
  const island = await import("../../../../src/web/client/islands/repo-graph");
  island.registerRepoGraph(fakeAlpine as never);
  if (!captured) throw new Error("registerRepoGraph did not register a factory");
  captured().init.call({ $root: root }); // ← real boot, one synchronous body
  return root;
}
