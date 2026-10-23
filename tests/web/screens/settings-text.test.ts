// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * settingsPageText — the Settings page as plain text, for dashboard chat's page
 * context (chat on Settings answered "I need more
 * context" because it was told only the page's name). Built from the same
 * helpers the page renders with, so chat reads what the page shows.
 */
import { describe, expect, test } from "bun:test";
import { settingsPageText } from "../../../src/web/screens/settings-text";
import { CAPS, NOW, NO_CALLS, VIEW } from "./settings-fixture";

const text = settingsPageText({ view: VIEW, caps: CAPS, last: NO_CALLS, now: NOW });

describe("settingsPageText", () => {
  test("names the page and what it is for", () => {
    expect(text).toContain("Agents");
    expect(text).toContain("Which coding agent you build with, and which ones Siltpoke uses for its own work.");
  });

  test("each coding agent on this machine, as its chip reads", () => {
    expect(text).toContain("claude — building · 19:40");
    expect(text).toContain("codex — not installed");
    expect(text).toContain("agy — installed");
  });

  test("each role: what it does, what it uses and why, its cap and today's count, its last call", () => {
    expect(text).toContain("Chat (answers you in the dashboard chat): qoder, its own default model — the only agent installed");
    expect(text).toContain("Critic (reviews your code after each turn): qoder, qoder-turbo — you chose it");
    expect(text).toContain("Summarizer (writes summaries and extracts memories): claude, claude-haiku-4-5-20251001");
    expect(text).toContain("daily cap 50, 20 used today");
    expect(text).toContain("no daily cap, 3 used today");
    expect(text).toContain("no answer recorded yet");
    expect(text).toContain("no review recorded yet");
  });

  // the window named codex's configured model while the
  // page row still said "model set in codex's own config". One wording, both places.
  test("a codex role names the model codex's own config sets; without one it says so", () => {
    const view = {
      ...VIEW,
      roles: VIEW.roles.map((r) => (r.role === "review" ? { role: "review" as const, family: "codex" as const, source: "pinned here" } : r)),
    };
    const withModel = settingsPageText({ view, caps: CAPS, last: NO_CALLS, now: NOW, codexModel: "gpt-5.6-sol" });
    expect(withModel).toContain("Critic (reviews your code after each turn): codex, gpt-5.6-sol, from codex's config — you chose it");
    const without = settingsPageText({ view, caps: CAPS, last: NO_CALLS, now: NOW });
    expect(without).toContain("codex, model set in codex's own config — you chose it");
  });

  test("what the controls do", () => {
    expect(text).toContain("Change model");
    expect(text).toContain("saves when the field is left");
  });
});
