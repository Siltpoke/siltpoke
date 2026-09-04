// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SettingsScreen smoke tests — the review-brain selector (Slice C / Task 8).
 */
import { describe, expect, test } from "bun:test";
import { SettingsScreen } from "../../../src/web/screens/Settings";
import type { BrainView } from "../../../src/cli/brain-cli";

const SECRET = "test-secret-xyz";

const VIEW: BrainView = {
  authorFamily: "codebuddy",
  families: ["claude", "codex", "agy", "qoder", "codebuddy"],
  roles: [
    { role: "chat", family: "claude", model: "claude-haiku-4-5-20251001", source: "default" },
    { role: "review", family: "qoder", model: "qoder-turbo", source: "pinned here" },
    { role: "extract", family: "claude", model: "claude-haiku-4-5-20251001", source: "default" },
  ],
  reviewByBuilder: [
    { builder: "claude", reviewer: "claude", model: "claude-haiku-4-5", configured: false, reviewerSupportsModel: true },
    { builder: "codex", reviewer: "codex", configured: false, reviewerSupportsModel: false },
    { builder: "agy", reviewer: "agy", configured: false, reviewerSupportsModel: false },
    { builder: "qoder", reviewer: "qoder", configured: false, reviewerSupportsModel: false },
    { builder: "codebuddy", reviewer: "codebuddy", configured: false, reviewerSupportsModel: false },
  ],
  claudeModels: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
};

describe("SettingsScreen", () => {
  test("renders the Dashboard shell", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    expect(html).toContain("data-sidebar");
    expect(html).toContain("WORK");
  });

  test("shows the builder author family", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    expect(html).toContain("codebuddy");
  });

  test("shows the resolved review family + model + source", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    expect(html).toContain("qoder");
    expect(html).toContain("qoder-turbo");
    expect(html).toContain("pinned here");
  });

  test("renders one builderRow island per builder family (5 rows)", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    const rows = html.match(/x-data="builderRow"/g) ?? [];
    expect(rows.length).toBe(5);
    for (const b of VIEW.families) {
      expect(html).toContain(`data-builder="${b}"`);
    }
  });

  test("each row seeds its reviewer from the view", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    // codex builder → reviewer=codex (same-family default)
    expect(html).toMatch(/data-builder="codex"[^>]*data-reviewer="codex"/);
  });

  test("model select renders for a claude reviewer; non-claude shows the honest 'own config' copy (v2.1)", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    // the claude model options appear (for the claude-reviewer row's select)
    for (const m of VIEW.claudeModels) {
      expect(html).toContain(`>${m}</option>`);
    }
    // model select is gated on reviewer===claude (hono/jsx escapes the quotes)
    expect(html).toContain("x-show=\"reviewer === &#39;claude&#39;\"");
    // the old misleading "auth-fixed" copy is GONE; the honest one is present
    expect(html).not.toContain("auth-fixed");
    expect(html).toContain("set in ");
    expect(html).toContain("own config");
  });

  test("section copy states the reviewer can be any family (cross-family), model claude-only (v2.1)", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    expect(html).toMatch(/any\s*<strong>?\s*family|any family/i);
    expect(html).toContain("cross-family");
  });

  test("a row whose reviewer differs from its builder shows a cross-family cue gated on that builder (v2.1)", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    // codex row (builder=codex) carries a cue gated on reviewer !== codex
    expect(html).toContain("x-show=\"reviewer !== &#39;codex&#39;\"");
  });

  test("renders one reviewer <option> per family", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    for (const f of VIEW.families) {
      expect(html).toContain(`>${f}</option>`);
    }
  });

  // REGRESSION GUARD: each builderRow reads the secret via closest("[data-secret]");
  // the gated POST is 401 without it. Every row's own x-data container must carry
  // data-secret (FloatingChat's data-secret is a sibling, not an ancestor).
  test("every builderRow container carries the daemon secret", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    const withSecret = html.match(/x-data="builderRow"[^>]*data-secret="test-secret-xyz"/g) ?? [];
    expect(withSecret.length).toBe(5);
  });
});

describe("SettingsScreen — directly-selectable role rows (Brain select v2.2)", () => {
  test("chat row stays read-only (auto-detect), no roleRow island", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    // chat is marked auto and does NOT become a roleRow island
    expect(html).toContain("auto");
    // no roleRow carries data-role="chat"
    expect(html).not.toMatch(/x-data="roleRow"[^>]*data-role="chat"/);
  });

  test("review + extract rows ARE roleRow islands with data-role + data-secret", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    for (const role of ["review", "extract"]) {
      expect(html).toMatch(new RegExp(`x-data="roleRow"[^>]*data-role="${role}"`));
    }
    // every roleRow carries the daemon secret on its own container
    const rows = html.match(/x-data="roleRow"[^>]*data-secret="test-secret-xyz"/g) ?? [];
    expect(rows.length).toBe(2); // review + extract
  });

  test("role-row model select is claude-only; non-claude shows the own-config copy", () => {
    const html = String(<SettingsScreen view={VIEW} secret={SECRET} />);
    // the family gate for the role-row model select
    expect(html).toContain("x-show=\"family === &#39;claude&#39;\"");
    expect(html).toContain("set in ");
  });
});
