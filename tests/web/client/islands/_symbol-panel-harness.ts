/** Fixture for tests that drive Code Map's SYMBOL panel and the trace card
 * reached from it: one subdir, one file, one function `doThing`.
 *
 * It boots the island through `mountRepoGraph` and replaces only `fetch`. The
 * fake server keeps the little state the real one would (was an explanation
 * generated; is a trace purpose cached) and records what the page asked for,
 * so a test can assert on the REQUESTS, not just on the pixels.
 */
import { jsonResponse, mountRepoGraph } from "./_dom-harness";

export const FILE = "src/alpha/a.ts";
export const CANONICAL = `function:${FILE}:doThing`;

export interface Posted {
  url: string;
  body: Record<string, unknown>;
}

/** What the fake server saw and holds. Reset by `openDoThing()`. */
export const server = {
  /** Cache-state reads, by `target` — "which node did the panel ask about". */
  stateReads: [] as string[],
  /** Every POST, with its parsed JSON body. */
  posts: [] as Posted[],
  generated: false,
  /** How many times the subdir's file list was fetched. */
  fileListReads: 0,
  /** When true, the file list fails to load once an explanation exists. */
  fileListBreaksAfterGenerate: false,
  /** The trace purpose the server has cached for `doThing`, if any. */
  cachedPurpose: null as string | null,
  /** The text the next purpose generation returns. */
  nextPurpose: "Does the thing.",
  /** When set, the next purpose POST fails with this reason (422), once. */
  purposeFailsWith: null as string | null,
  /** `doThing`'s code comment as the trace reports it, or null for none. */
  codeComment: null as string | null,
  /** What GET /api/repo-graph/staleness answers as `data`; null = an empty body (a failed check). */
  staleness: null as Record<string, unknown> | null,
};

const ok = (body: unknown): Promise<Response> => Promise.resolve(jsonResponse(body));
const status = (code: number): Promise<Response> => Promise.resolve(new Response("{}", { status: code }));

const FILES_BODY = {
  data: {
    files: [{ name: "a.ts", path: FILE, loc: 20, symbols: 1, functions: 1, desc: "", explainState: "none" }],
    intraEdges: [],
  },
};
const SYMBOLS_BODY = {
  data: { symbols: [{ name: "doThing", kind: "function", line: 3, signature: "doThing()" }], callEdges: [] },
};
const RESULT_BODY = {
  data: {
    target: `${FILE}:doThing`,
    title: "doThing",
    grounded: 1,
    fresh: true,
    lead: "Does the thing.",
    dependsOn: [],
    usedBy: [],
    citations: [],
  },
};
const TRACE_NODE = {
  id: CANONICAL,
  fn: "doThing",
  module: "alpha",
  file: "a.ts",
  path: FILE,
  line: 3,
  signature: "doThing()",
  io: { input: "", output: "" },
  purpose: { src: "none" },
  type: "function",
  role: "entry",
};

function traceNode(): typeof TRACE_NODE & { purpose: { src: string; text?: string } } {
  return server.codeComment === null
    ? TRACE_NODE
    : { ...TRACE_NODE, purpose: { src: "jsdoc", text: server.codeComment } };
}

function filesRoute(): Promise<Response> {
  server.fileListReads++;
  return server.generated && server.fileListBreaksAfterGenerate ? status(500) : ok(FILES_BODY);
}

/** POST starts the detached generate; GET reads the cache state for `target`. */
function explainRoute(url: string, method: string): Promise<Response> {
  if (method === "POST") {
    server.generated = true;
    return ok({ taskId: "t1" });
  }
  const target = new URL(url, "http://x").searchParams.get("target") ?? "";
  server.stateReads.push(target);
  // The real route answers 400 for an empty target.
  if (target === "") return status(400);
  return ok({ data: { state: server.generated && target === CANONICAL ? "valid" : "none" } });
}

/** GET reads the cached purpose; POST generates one and caches it. */
function purposeRoute(method: string): Promise<Response> {
  if (method === "POST" && server.purposeFailsWith !== null) {
    const error = server.purposeFailsWith;
    server.purposeFailsWith = null;
    return Promise.resolve(new Response(JSON.stringify({ success: false, error }), { status: 422 }));
  }
  if (method === "POST") {
    server.cachedPurpose = server.nextPurpose;
    return ok({ data: { text: server.cachedPurpose, cite: `${FILE}:3` } });
  }
  return server.cachedPurpose === null
    ? ok({ data: { state: "none" } })
    : ok({ data: { state: "cached", text: server.cachedPurpose, cite: `${FILE}:3` } });
}

function route(url: string, method: string): Promise<Response> {
  if (url.includes("/api/repo-graph/files")) return filesRoute();
  if (url.includes("/api/repo-graph/symbols")) return ok(SYMBOLS_BODY);
  if (url.includes("/api/repo-graph/staleness")) return ok({ success: true, data: server.staleness });
  // Before "/explain": a substring test on that would swallow this one.
  if (url.includes("/api/repo-graph/explain/result")) return ok(RESULT_BODY);
  if (url.includes("/api/repo-graph/arch/task")) return ok({ data: { task: { id: "t1", status: "done" } } });
  if (url.includes("/api/repo-graph/explain")) return explainRoute(url, method);
  if (url.includes("/api/repo-graph/trace/purpose")) return purposeRoute(method);
  if (url.includes("/api/repo-graph/trace"))
    return ok({ data: { entry: CANONICAL, depth: 2, spine: [CANONICAL], nodes: [traceNode()], edges: [] } });
  return ok({ success: true, data: {} });
}

function installServer(): void {
  Object.assign(server, {
    stateReads: [],
    posts: [],
    generated: false,
    fileListReads: 0,
    fileListBreaksAfterGenerate: false,
    cachedPurpose: null,
    nextPurpose: "Does the thing.",
    codeComment: null,
    purposeFailsWith: null,
    staleness: null,
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      server.posts.push({ url, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") });
    }
    return route(url, method);
  }) as typeof fetch;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick();
}

type FocusFn = (t: { name: string; path: string; node_type?: string }) => Promise<boolean>;

/** Mount the page and open `doThing`'s symbol panel. */
export async function openDoThing(before?: () => void): Promise<HTMLElement> {
  installServer();
  before?.();
  const root = await mountRepoGraph();
  const focus = (window as unknown as { __siltpokeFocusNode?: FocusFn }).__siltpokeFocusNode;
  if (!focus) throw new Error("island did not expose __siltpokeFocusNode");
  const found = await focus({ name: "doThing", path: FILE, node_type: "function" });
  if (!found) throw new Error("fixture could not navigate to the symbol");
  await settle();
  return root;
}

/** Click an element that must exist, then let the page settle. */
export async function click(root: HTMLElement, selector: string): Promise<void> {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  el.click();
  await settle();
}

export function foot(root: HTMLElement): { act: string; text: string; cantTrace: boolean; canTrace: boolean } {
  const btn = root.querySelector<HTMLElement>("#rg-expl-btn");
  if (!btn) throw new Error("no #rg-expl-btn in the panel foot");
  return {
    act: btn.dataset.act ?? "",
    text: (btn.parentElement?.textContent ?? "").replace(/\s+/g, " "),
    cantTrace: root.querySelector("#rg-sym-trace-na") !== null,
    canTrace: root.querySelector("#rg-sym-trace-btn") !== null,
  };
}
