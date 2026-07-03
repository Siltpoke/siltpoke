# `web/routes/` — web-owned SSR routes

Mounted from `src/daemon/server.ts` via `mount*Routes(app, ...)` helpers.
Routes here render JSX views server-side and return HTML.

## What belongs here

A route belongs in `web/routes/` when **both** of the following hold:

1. The handler renders a JSX `<Screen>` component and returns HTML
   (via `c.html(...)`).
2. The route has no API counterpart with shared auth / shared loader
   that would force them to live together. (Pairs like that go to
   `daemon/routes/` — see `src/daemon/routes/README.md`.)

Current inventory (10 files):
- `home.tsx` / `memory.tsx` / `chat.tsx` / `critic.tsx` / `traces.tsx` —
  primary screens.
- `preview.tsx` — dev preview registry (env-gated, dropped in prod).
- `static.ts` — static asset serving (technically infra, but reads from
  `public/static/` which is web-owned).
- `nav.ts` — canonical nav schema (shared by all SSR screens).
- `rubric.tsx` / `preference-log.tsx` / `few-shot.tsx` /
  `repo-memory.tsx` — SSR routes (paired with API routes in
  `daemon/routes/` of the same name; the paired API handles shared auth).

## What does NOT belong here

- Pure API / SSE endpoints → live in `src/daemon/routes/`.
- Hook ingestion (`/hooks/*`) → daemon-only.
- Health / version endpoints → daemon-only.

## Import constraints

- ✅ `web/routes/*` may import from `web/screens/*`, `web/primitives/*`,
  `web/_shared/*`, `state/api.ts` (the web → state port).
- ❌ `web/routes/*` must NOT import from `daemon/*` internals — enforced
  by `dependency-cruiser` rule `web-routes-no-daemon`.
- ❌ `web/routes/*` must NOT import from `state/*` directly — must go
  through `state/api.ts` (enforced by rule
  `web-must-go-through-state-api`).

## Convention (locked 2026-05-23)

No file moves were required at lock time.
