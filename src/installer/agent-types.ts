// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

/** Every agent siltpoke's menu can list (supported or detect-only). */
export type SupportedAgent =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "codebuddy"
  | "qodercli";

/**
 * Agents siltpoke can actually wire into (a real host adapter or the
 * anchor). As of the agy track this mirrors SupportedAgent exactly — every
 * listed agent now has a real HostAdapter. Kept as a distinct alias (rather
 * than collapsing to SupportedAgent everywhere) for the semantic boundary:
 * this type documents "safe to pass to wireSecondaryHosts", which matters
 * again the moment a future detect-only placeholder is reintroduced.
 */
export type AgentTarget = "claude-code" | "codex" | "codebuddy" | "qodercli" | "antigravity";
