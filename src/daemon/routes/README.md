# `daemon/routes/` — daemon-owned HTTP routes

Mounted from `src/daemon/server.ts` via `mount*Routes(app, ...)` helpers.
All routes share the daemon's port (`:9876` by default) and lifecycle.

## What belongs here

A route belongs in `daemon/routes/` when **any** of the following hold:

1. **API endpoint** returning JSON / SSE for programmatic consumers
   (CLI, hooks, external callers).
   Examples: `/api/facts`, `/api/chat`, `/api/critiques/:id/feedback`.
2. **Infrastructure surface** — `/api/ping`, `/api/version`, `/hooks/stop`
   (Claude hook ingestion).
3. **API + SSR pair for the same resource** when both need shared auth /
   shared loader logic. Examples:
   - `critique.tsx` — `GET /api/critiques/:id` (JSON) + `GET /critique/:id`
     (HTML permalink). Both need `secret` access + share the critique loader.
4. **HTMX fragment endpoints** that emit partial HTML for a client-side
   swap rather than a full page. Example: `dashboard.ts` `POST /api/action`
   returns a Hero fragment + OOB stats panel for HTMX to swap into Home.

## What does NOT belong here

- Pure SSR screen routes that render a JSX view → live in
  `src/web/routes/` (see `src/web/routes/README.md`).
- Business logic — routes are thin handlers. Logic belongs in
  `src/critic/`, `src/memory/`, `src/state/`, etc.

## Import constraints

- ✅ `daemon/routes/*` MAY import from `web/` when it needs JSX
  components for SSR responses (e.g. `dashboard-helpers.tsx` imports
  `web/primitives/*`).
- ❌ `web/routes/*` must NOT import from `daemon/*` (enforced by
  `dependency-cruiser` rule `web-routes-no-daemon`).

## Convention (locked 2026-05-23)

No file moves were required at lock time — current placement of all 10
files in this directory is consistent with the rules above.
