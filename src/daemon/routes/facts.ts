// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * HTTP routes for fact lifecycle management.
 *
 * - GET    /api/facts                   → list (optional ?status filter, sort desc)
 * - POST   /api/facts/:id/approve       → pending → active (409 on non-pending)
 * - POST   /api/facts/:id/retire        → * → retired (idempotent on already-retired)
 *
 * All endpoints require the `X-Siltpoke-Secret` header (timing-safe compared
 * against `deps.secret`). State mutations delegate to the pure-function core
 * in `src/memory/transitions.ts`; this module is the imperative shell that
 * reads memory, dispatches the transition, and writes the result.
 */

import type { Context, Hono } from "hono";
import { makeRoleRawBrain } from "../../brain/role-brain";
import { GLOBAL_ONLY, type CoreMemory, type Fact, type ProjectScope } from "../../memory/memory";
import {
  type MemoryEditResult,
  parseMemoryEdit,
} from "../../memory/nl-edit";
import {
  addFactCore,
  approveFactCore,
  type FactDraft,
  reactivateFactCore,
  restateFactCore,
  retireFactCore,
  setFactKindCore,
  setFactPinnedCore,
  type TransitionError,
} from "../../memory/transitions";
import { isAuthorized } from "../auth";
import type { DaemonProject } from "../../memory/active-project";
import { resolveRequestProject } from "../project-context";
import type { BudgetSignal, QuietHoursSignal } from "./chat";

export interface FactsDeps {
  homeBase: string;
  secret: string;
  /**
   * Loads the canonical memory document. The retire handler relies on the
   * returned reference being stable across calls for already-retired facts —
   * if the reader returns a structurally-equal but newly-allocated object on
   * every call, the idempotent-write skip at `retireFactCore`'s reference
   * check stops working and writeMemory fires on every retire call.
   * Production `readMemory` from `src/memory/memory.ts` satisfies this (the
   * Zod parse output is stable for a given on-disk state within a request).
   *
   * `projectCwd`: the scope `resolveScope` resolves from the request's `?repo=`
   * — `project_root` for a resolved project (so an untagged fact in that
   * project's slice is read/written), else `GLOBAL_ONLY`. `readMemoryV3Merged`
   * merges global + project on read; `writeMemoryV3Split` re-partitions on write
   * (style/profile → global, untagged → slice), preserving `isGlobalFact`.
   */
  readMemory: (homeBase: string, projectCwd?: ProjectScope) => Promise<CoreMemory | null>;
  writeMemory: (homeBase: string, memory: CoreMemory, projectCwd?: ProjectScope) => Promise<void>;
  /**
   * Clock injection. MUST return an ISO-8601 string (`new Date().toISOString()`
   * shape). The Zod schema in `memory.ts` validates `last_seen_at` on the next
   * read; a non-ISO value would quarantine the fact store as corrupt.
   */
  now?: () => string;
  /**
   * Injectable NL-edit parser for `POST /api/facts/parse`. Defaults to the
   * real `parseMemoryEdit` (one Brain haiku call). Tests inject a stub so the
   * route is exercised without a live LLM. NEVER writes — parse only.
   */
  parseFn?: (text: string, activeFacts: Fact[]) => Promise<MemoryEditResult>;
  /**
   * Budget + quiet-hours gate for the interactive parse call. Mirrors the
   * chat composer's `checkSendGate`: returns a blocked signal or null (pass).
   * Absent dep → no gate (fail-open). On block, `/parse` returns a structured
   * `{ paused: true, reason }` (HTTP 200) instead of making the Brain call.
   */
  checkSendGate?: () => Promise<BudgetSignal | QuietHoursSignal | null>;
  /**
   * Resolves the request's project scope from `?repo=` (the projHash the client
   * appends to every action fetch). `resolveScope` calls this then maps
   * `project_root ?? GLOBAL_ONLY`, so an action reads/writes the SAME merged
   * scope the Memory Book READ used — the fix for untagged-fact-in-project-slice
   * actions 404'ing. Defaults to the real `resolveRequestProject`; injectable so
   * the facts-route tests drive resolution deterministically (a stub returning
   * `project_root: null` exercises the GLOBAL_ONLY fallback). Was declared-unused
   * after Task 16 dropped the write-eligibility guard; now the live scope source.
   */
  resolveProject?: (
    home: string,
    explicitProjHash: string | undefined,
  ) => Promise<DaemonProject>;
}

// Exhaustive enum map — keying on `Fact["status"]` forces a compile error if a
// new status is added to the schema without updating this lookup. Missing
// member would surface here rather than silently 400-ing the new query value.
const VALID_STATUSES_MAP = {
  pending: true,
  active: true,
  retired: true,
  retire_proposed: true,
} as const satisfies Record<Fact["status"], true>;

const VALID_STATUSES: ReadonlyArray<Fact["status"]> = Object.keys(
  VALID_STATUSES_MAP,
) as Fact["status"][];

function isValidStatus(value: string): value is Fact["status"] {
  return (VALID_STATUSES as ReadonlyArray<string>).includes(value);
}

// Every route below starts with the same X-Siltpoke-Secret check. Returns the
// 401 Response to short-circuit on, or null when the request is authorized.
function authGuard(c: Context, secret: string): Response | null {
  if (!isAuthorized(secret, c.req.header("X-Siltpoke-Secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

// Shared "load the fact store, 404 if it doesn't exist yet" preamble used by
// every :id transition route (approve/kind/retire/reactivate/restate) — all
// five read the same way and 404 with the same body on a missing store.
/**
 * Resolve the SAME merged scope the Memory Book READ used, from the `?repo=`
 * the client (memory-book.ts) already appends to every action fetch. The book
 * shows `readMemoryV3Merged` (global + resolved project); an untagged fact
 * lives in the project slice, so an action that read/wrote GLOBAL_ONLY could
 * never find it → 404. Resolving here (project_root → that slice, else
 * GLOBAL_ONLY) makes actions honor exactly what the page displayed.
 * `writeMemoryV3Split` re-partitions on write (style/profile → global, untagged
 * → slice), so the isGlobalFact boundary is preserved and no migration runs.
 */
async function resolveScope(c: Context, deps: FactsDeps): Promise<ProjectScope> {
  const resolve =
    deps.resolveProject ?? ((home, repo) => resolveRequestProject(home, repo));
  const proj = await resolve(deps.homeBase, c.req.query("repo"));
  return proj.project_root ?? GLOBAL_ONLY;
}

async function loadMemoryOrNotFound(
  c: Context,
  deps: FactsDeps,
  id: string,
): Promise<{ memory: CoreMemory; scope: ProjectScope } | { response: Response }> {
  const scope = await resolveScope(c, deps);
  const memory = await deps.readMemory(deps.homeBase, scope);
  if (!memory) {
    return { response: c.json({ error: "not_found", id }, 404) };
  }
  return { memory, scope };
}

// approve/retire/reactivate/restate all start with the exact same
// auth-check -> load-or-404 preamble once the :id param is in hand (kind.ts
// does the same load but interleaved with its own body validation, so it
// stays separate to avoid reordering when its 400s fire relative to the 404
// check). `id` is extracted by the caller — Hono infers a plain `string`
// (not `string | undefined`) for `:id` params only at a route's own typed
// call site, so hoisting the `.param("id")` call into this untyped helper
// would widen the type and require a redundant runtime check.
//
// Task 16 removed the Task 11 write-eligibility gate that used to sit here.
// The `resolveProject` dep it introduced is now the live SCOPE source instead
// (facts are project-scoped again: untagged → slice, style/profile → global —
// see `resolveScope` above and the `FactsDeps.resolveProject` doc comment).
// Auth still runs BEFORE scope resolution, so an unauthorized request never
// touches project state.
async function authAndLoad(
  c: Context,
  deps: FactsDeps,
  id: string,
): Promise<{ memory: CoreMemory; scope: ProjectScope } | { response: Response }> {
  const unauthorized = authGuard(c, deps.secret);
  if (unauthorized) return { response: unauthorized };
  return loadMemoryOrNotFound(c, deps, id);
}

// approveFactCore and retireFactCore share the exact same TransitionError ->
// HTTP mapping (not_found -> 404, not_pending -> 409, every other kind the
// core doesn't currently produce for these two transitions -> 500 with an
// "unexpected transition error" detail). Extracted verbatim from both
// handlers — same status codes, same response bodies.
function respondApproveOrRetireError(
  c: Context,
  err: TransitionError,
  id: string,
) {
  switch (err.kind) {
    case "not_found":
      return c.json({ error: "not_found", id }, 404);
    case "not_pending":
      return c.json(
        { error: "not_pending", current_status: err.current_status },
        409,
      );
    case "not_retire_proposed":
    case "already_retired":
    case "not_retired":
      return c.json(
        {
          error: "internal",
          detail: `unexpected transition error: ${err.kind}`,
        },
        500,
      );
    default: {
      // Compile-time guard: future TransitionError kinds become a type error
      // here. If somehow reached at runtime (e.g. core diverges from types),
      // return 500 rather than returning `never` (which would hang the
      // request because Hono never sees a Response).
      const _exhaustive: never = err;
      void _exhaustive;
      return c.json({ error: "internal_error" }, 500);
    }
  }
}

export function mountFactsRoutes(app: Hono, deps: FactsDeps): void {
  app.get("/api/facts", async (c) => {
    const unauthorized = authGuard(c, deps.secret);
    if (unauthorized) return unauthorized;

    const statusParam = c.req.query("status");
    if (statusParam !== undefined && !isValidStatus(statusParam)) {
      return c.json({ error: "invalid_status" }, 400);
    }

    const memory = await deps.readMemory(deps.homeBase, await resolveScope(c, deps));
    const allFacts = memory?.facts ?? [];
    const filtered =
      statusParam === undefined
        ? allFacts
        : allFacts.filter((f) => f.status === statusParam);

    // Sort by created_at descending (newest first). Slice to avoid mutating
    // the underlying array reference from memory.
    const sorted = [...filtered].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );

    return c.json({ facts: sorted }, 200);
  });

  app.post("/api/facts/:id/approve", async (c) => {
    const id = c.req.param("id");
    const loaded = await authAndLoad(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const result = approveFactCore(memory, id, deps.now);
    if (result.ok) {
      await deps.writeMemory(deps.homeBase, result.memory, scope);
      return c.json({ fact: result.fact }, 200);
    }

    return respondApproveOrRetireError(c, result.error, id);
  });

  // Re-tag a fact's communication-style classification (style/profile).
  // The /memory kind badge POSTs here. Mirrors /approve (auth → read → core →
  // write) + a body-validated `kind`. Idempotent: setFactKindCore returns the
  // input memory reference when the kind is unchanged → skip writeMemory.
  app.post("/api/facts/:id/kind", async (c) => {
    const unauthorized = authGuard(c, deps.secret);
    if (unauthorized) return unauthorized;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const kind = (body as { kind?: unknown })?.kind;
    if (kind !== "style" && kind !== "profile") {
      return c.json({ error: "invalid_kind" }, 400);
    }

    const id = c.req.param("id");
    const loaded = await loadMemoryOrNotFound(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const result = setFactKindCore(memory, id, kind, deps.now);
    if (result.ok) {
      if (result.memory !== memory) {
        // Tagging untagged→style/profile flips isGlobalFact → writeMemoryV3Split
        // moves the fact from the project slice into global. Intended promote.
        await deps.writeMemory(deps.homeBase, result.memory, scope);
      }
      return c.json({ fact: result.fact }, 200);
    }

    const err: TransitionError = result.error;
    switch (err.kind) {
      case "not_found":
        return c.json({ error: "not_found", id }, 404);
      case "not_pending":
      case "not_retire_proposed":
      case "not_retired":
      case "already_retired":
        return c.json(
          { error: "internal", detail: `unexpected transition error: ${err.kind}` },
          500,
        );
      default: {
        const _exhaustive: never = err;
        void _exhaustive;
        return c.json({ error: "internal_error" }, 500);
      }
    }
  });

  // Pin/unpin a fact against decay. Mirrors /kind: authGuard + body-validated
  // boolean + write. Wires the "manual hard-constraint protection" affordance
  // the schema promised (memory.ts:160) for facts not born pinned via
  // /remember.
  //
  // Unlike setFactKindCore, setFactPinnedCore has NO reference-equality
  // idempotency guard (confirmed transitions.ts:462-479 — it unconditionally
  // calls replaceFact and allocates a fresh memory object even when `pinned`
  // is unchanged). The endpoint compares the PRE-transition fact's `pinned`
  // value itself to decide whether to skip writeMemory, since the core
  // doesn't signal that via `result.memory !== memory` the way /kind's does.
  app.post("/api/facts/:id/pin", async (c) => {
    const unauthorized = authGuard(c, deps.secret);
    if (unauthorized) return unauthorized;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const pinned = (body as { pinned?: unknown })?.pinned;
    if (typeof pinned !== "boolean") {
      return c.json({ error: "invalid_body" }, 400);
    }

    const id = c.req.param("id");
    const loaded = await loadMemoryOrNotFound(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const existingFact = memory.facts.find((f) => f.id === id);
    const result = setFactPinnedCore(memory, id, pinned, deps.now);
    if (result.ok) {
      if (existingFact?.pinned !== pinned) {
        await deps.writeMemory(deps.homeBase, result.memory, scope);
      }
      return c.json({ fact: result.fact }, 200);
    }

    const err: TransitionError = result.error;
    switch (err.kind) {
      case "not_found":
        return c.json({ error: "not_found", id }, 404);
      case "already_retired":
        return c.json({ error: "already_retired", id }, 409);
      case "not_pending":
      case "not_retire_proposed":
      case "not_retired":
        return c.json(
          { error: "internal", detail: `unexpected transition error: ${err.kind}` },
          500,
        );
      default: {
        const _exhaustive: never = err;
        void _exhaustive;
        return c.json({ error: "internal_error" }, 500);
      }
    }
  });

  app.post("/api/facts/:id/retire", async (c) => {
    const id = c.req.param("id");
    const loaded = await authAndLoad(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const result = retireFactCore(memory, id, deps.now);
    if (result.ok) {
      // Idempotent no-op: when the core returns the input memory reference
      // unchanged the fact was already retired — skip writeMemory.
      if (result.memory !== memory) {
        await deps.writeMemory(deps.homeBase, result.memory, scope);
      }
      return c.json({ fact: result.fact }, 200);
    }

    // Retire currently only produces `not_found`, but the shared mapping
    // matches the approve handler so a future kind is caught the same way.
    return respondApproveOrRetireError(c, result.error, id);
  });

  // POST /api/facts/:id/reactivate → retired → active (undo a retire).
  app.post("/api/facts/:id/reactivate", async (c) => {
    const id = c.req.param("id");
    const loaded = await authAndLoad(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const result = reactivateFactCore(memory, id, deps.now);
    if (result.ok) {
      await deps.writeMemory(deps.homeBase, result.memory, scope);
      return c.json({ fact: result.fact }, 200);
    }

    const err: TransitionError = result.error;
    switch (err.kind) {
      case "not_found":
        return c.json({ error: "not_found", id }, 404);
      case "not_retired":
        return c.json(
          { error: "not_retired", current_status: err.current_status },
          409,
        );
      case "not_pending":
      case "not_retire_proposed":
      case "already_retired":
        return c.json(
          {
            error: "internal",
            detail: `unexpected transition error: ${err.kind}`,
          },
          500,
        );
      default: {
        const _exhaustive: never = err;
        void _exhaustive;
        return c.json({ error: "internal_error" }, 500);
      }
    }
  });

  // POST /api/facts → create a new (pending) fact from the NL-edit composer.
  // Body: { text, confidence?, save_reason?, supersedes? }. Lands pending;
  // the supersede link (if any) is set on the old fact but it stays active
  // until the new fact is approved.
  app.post("/api/facts", async (c) => {
    const unauthorized = authGuard(c, deps.secret);
    if (unauthorized) return unauthorized;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const b = body as Partial<FactDraft>;
    if (typeof b?.text !== "string" || b.text.trim() === "") {
      return c.json({ error: "invalid_text" }, 400);
    }
    const draft: FactDraft = {
      text: b.text,
      // User-typed memory is an explicit, high-confidence claim — but still
      // lands pending for review. 0.9 is the default when unspecified.
      confidence: typeof b.confidence === "number" ? b.confidence : 0.9,
      save_reason: typeof b.save_reason === "string" ? b.save_reason : null,
      supersedes: typeof b.supersedes === "string" ? b.supersedes : null,
    };

    const scope = await resolveScope(c, deps);
    const memory = await deps.readMemory(deps.homeBase, scope);
    if (!memory) {
      return c.json({ error: "not_found" }, 404);
    }

    // Supersession guard: you may only replace a currently-ACTIVE fact. The UI
    // never names a non-active target (parseMemoryEdit only returns active
    // ids), but a direct authenticated caller could — and superseding a
    // retired/pending fact would let a later approve overwrite its
    // retired_reason / pre-empt its own review. Reject before any write.
    if (draft.supersedes) {
      const target = memory.facts.find((f) => f.id === draft.supersedes);
      if (!target) {
        return c.json({ error: "not_found", id: draft.supersedes }, 404);
      }
      if (target.status !== "active") {
        return c.json(
          { error: "not_active", current_status: target.status },
          409,
        );
      }
    }

    const result = addFactCore(memory, draft, deps.now);
    if (result.ok) {
      await deps.writeMemory(deps.homeBase, result.memory, scope);
      return c.json({ fact: result.fact }, 201);
    }

    const err: TransitionError = result.error;
    // addFactCore only fails when a named `supersedes` target is missing.
    if (err.kind === "not_found") {
      return c.json({ error: "not_found", id: err.id }, 404);
    }
    return c.json({ error: "internal_error" }, 500);
  });

  // POST /api/facts/:id/restate → reconfirm an existing fact (NL ); a
  // pending target is approved, an active target gets its clocks refreshed.
  app.post("/api/facts/:id/restate", async (c) => {
    const id = c.req.param("id");
    const loaded = await authAndLoad(c, deps, id);
    if ("response" in loaded) return loaded.response;
    const { memory, scope } = loaded;

    const result = restateFactCore(memory, id, deps.now);
    if (result.ok) {
      await deps.writeMemory(deps.homeBase, result.memory, scope);
      return c.json({ fact: result.fact }, 200);
    }

    const err: TransitionError = result.error;
    if (err.kind === "not_found") {
      return c.json({ error: "not_found", id }, 404);
    }
    if (err.kind === "not_pending") {
      return c.json(
        { error: "not_pending", current_status: err.current_status },
        409,
      );
    }
    return c.json({ error: "internal_error" }, 500);
  });

  // POST /api/facts/parse → interactive NL-edit intent parse.
  // Body { text }. Makes ONE Brain haiku call (parseMemoryEdit) that extracts a
  // candidate claim + classifies it against the user's ACTIVE facts. NEVER
  // writes — returns a structured result for the composer to render a proposal.
  // Gated by budget/quiet-hours (mirrors the chat composer): a block returns
  // { paused: true, reason } at HTTP 200 (never a silent failure).
  app.post("/api/facts/parse", async (c) => {
    const unauthorized = authGuard(c, deps.secret);
    if (unauthorized) return unauthorized;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== "string" || text.trim() === "") {
      return c.json({ error: "invalid_text" }, 400);
    }

    // Budget / quiet-hours gate — mirrors the chat composer's checkSendGate.
    // Fail-open: absent dep or any error → proceed (never brick the composer).
    if (deps.checkSendGate) {
      let gateSignal: BudgetSignal | QuietHoursSignal | null = null;
      try {
        gateSignal = await deps.checkSendGate();
      } catch {
        // Fail-open: gate error → treat as "no block".
      }
      if (gateSignal !== null) {
        return c.json({ paused: true, reason: gateSignal.blocked }, 200);
      }
    }

    const memory = await deps.readMemory(deps.homeBase, await resolveScope(c, deps));
    const activeFacts = (memory?.facts ?? []).filter(
      (f) => f.status === "active",
    );

    let result: MemoryEditResult;
    try {
      result = deps.parseFn
        ? await deps.parseFn(text, activeFacts)
        : await parseMemoryEdit(text, activeFacts, {
            brainFn: makeRoleRawBrain(deps.homeBase, "extract"),
          });
    } catch {
      // Parse / Brain failure — honest non-2xx so the composer toasts and never
      // fabricates a write.
      return c.json({ error: "parse_failed" }, 502);
    }

    // The target id is already code-validated inside parseMemoryEdit (a phantom
    // or non-active target is downgraded to "add"); surface the full fact for
    // the proposal preview on restate/contradict.
    const matched =
      result.target_fact_id !== null
        ? (activeFacts.find((f) => f.id === result.target_fact_id) ?? null)
        : null;
    const contradictedFact = matched
      ? { id: matched.id, text: matched.text }
      : null;

    return c.json(
      {
        candidate: result.candidate_claim,
        classification: result.classification,
        confidence: result.confidence,
        targetFactId: result.target_fact_id,
        contradictedFact,
      },
      200,
    );
  });
}
