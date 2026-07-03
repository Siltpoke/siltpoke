// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// Public state port for the `web/` layer.
//
// Boundary rule: web/ may NOT import from state/ directly.
//
// Anything web/* legitimately needs from state/* is re-exported here.
// The boundary is enforced by `dependency-cruiser` rule:
//
//   from.path = '^src/web/' AND to.path = '^src/state/(?!api\\.ts)' -> error
//
// To add a new export: add it here AND audit that the underlying state
// module's read-write semantics are appropriate for web consumption.
// Bias toward read functions; writes are OK when they back legitimate
// user-action endpoints (e.g. appendFeedback for the critic verdict form).

// --- critic telemetry ---------------------------------------------------
export { readCriticTelemetry } from "./critic-event-log";
export type {
  CriticTelemetry,
  CriticCall,
  CallStatus,
  StatusFilter,
  SpeechKind,
  TimeRange,
  SortOrder,
  UserActionStats,
} from "./critic-event-log";

// --- critique feedback (user verdict actions) ---------------------------
export { appendFeedback, readFeedbackHistory } from "./critique-feedback";
export type { FeedbackAction } from "./critique-feedback";

// --- progression (XP / actions / daily counters) ------------------------
export { readProgression, actionXpToday, ACTION_XP_DAILY_CAP, xpPanelData } from "./progression";
export type { DailyActions, Progression } from "./progression";

// --- v2 sidecar (critique evidence frontmatter) -------------------------
export type { V2SidecarData, V2RubricTrigger } from "./v2-sidecar";
export { loadSidecarForCritique } from "./critique-sidecar-loader";

// --- vitals (mood/hunger/energy series) ---------------------------------
export { readVitalsSeries } from "./vitalsReader";
