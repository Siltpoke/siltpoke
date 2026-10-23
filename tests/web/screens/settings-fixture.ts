// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** The view the Settings screen tests share. */
import type { BrainView } from "../../../src/cli/brain-cli";

export const SECRET = "test-secret-xyz";
/** Each role's cap and calls today (spec §12.3). */
export const CAPS = { caps: { chat: 50, review: 50, extract: 0 }, usage: { chat: 20, review: 12, extract: 3 } };

export const VIEW: BrainView = {
  authorFamily: "claude",
  buildingWith: "codebuddy",
  buildingWithSeenAt: "2026-10-13T12:00:00.000Z",
  buildingWithModel: null,
  families: ["claude", "codex", "agy", "qoder", "codebuddy"],
  chat: { kind: "use", family: "qoder", source: "installed" },
  roles: [
    { role: "chat", family: "qoder", source: "only one installed" },
    { role: "review", family: "qoder", model: "qoder-turbo", source: "pinned here" },
    { role: "extract", family: "claude", model: "claude-haiku-4-5-20251001", source: "default" },
  ],
  // reviewerSupportsModel now follows each CLI's real argv: only codex cannot be
  // given a model (spec brain-select-four-gaps §2.6).
  reviewByBuilder: [
    { builder: "claude", reviewer: "claude", model: "claude-haiku-4-5", configured: false, reviewerSupportsModel: true, overriddenByGlobalPin: false },
    { builder: "codex", reviewer: "codex", configured: false, reviewerSupportsModel: false, overriddenByGlobalPin: false },
    { builder: "agy", reviewer: "agy", configured: false, reviewerSupportsModel: true, overriddenByGlobalPin: false },
    { builder: "qoder", reviewer: "qoder", configured: false, reviewerSupportsModel: true, overriddenByGlobalPin: false },
    { builder: "codebuddy", reviewer: "codebuddy", configured: false, reviewerSupportsModel: true, overriddenByGlobalPin: false },
  ],
  claudeModels: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
  modelCapableFamilies: ["claude", "agy", "qoder", "codebuddy"],
  agents: [
    { family: "claude", installed: true, seenAt: new Date(2026, 9, 14, 19, 40).toISOString() },
    { family: "codex", installed: false, seenAt: null },
    { family: "agy", installed: true, seenAt: null },
    { family: "qoder", installed: true, seenAt: null },
    { family: "codebuddy", installed: false, seenAt: null },
  ],
};

/** What the records say happened last (`lastCalls`); nothing by default. */
export const NO_CALLS = { chat: null, review: null };

/** A fixed "now" on the same local day as the fixture's times. */
export const NOW = new Date(2026, 9, 14, 21, 0);
