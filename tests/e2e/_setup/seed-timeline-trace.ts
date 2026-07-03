/**
 * seed-timeline-trace — bun-run helper for the /timeline screenshot spec.
 *
 * TraceStore rides on bun:sqlite, which Node (the Playwright runner) can't
 * import — so timeline-e2e-fixtures spawns THIS script under bun to write
 * the linked trace (sqlite index + day-partition JSONL) into the e2e home.
 * Everything else the spec seeds is plain fs and stays Node-side.
 *
 * Usage: bun tests/e2e/_setup/seed-timeline-trace.ts
 */
import { seedTrace } from "../../web/routes/timeline-fixtures";
import { E2E_HOME } from "./honesty-e2e-fixtures";
import { TL_CRITIQUE_ID, TL_TRACE_ID } from "./timeline-e2e-fixtures";

// io: true → the brain span carries siltpoke.input/output so the tl-04
// screenshot's expanded span panel shows a real Messages tab.
await seedTrace(E2E_HOME, TL_CRITIQUE_ID, TL_TRACE_ID, { io: true });
