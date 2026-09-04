// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * ResolvedContextBadge — makes the daemon's per-request project resolution
 * VISIBLE (source + display_name + short proj_hash), so a wrong or empty
 * resolution shows up on the page instead of silently rendering the wrong
 * scope's data. See src/memory/active-project.ts for the source taxonomy.
 */
import { test, expect, describe } from "bun:test";
import { ResolvedContextBadge } from "../../../src/web/primitives/ResolvedContextBadge";

describe("ResolvedContextBadge", () => {
  test("renders display name + short hash + source for a resolved project", () => {
    const html = String(
      ResolvedContextBadge({
        source: "recent",
        displayName: "siltpoke",
        projHash: "d752c853b0ee1e50",
      }),
    );
    expect(html).toContain("siltpoke");
    expect(html).toContain("recent");
  });

  test("hash is truncated to the first 7 chars in the hash span (full hash stays in the tooltip title)", () => {
    const html = String(
      ResolvedContextBadge({
        source: "explicit",
        displayName: "siltpoke",
        projHash: "d752c853b0ee1e50",
      }),
    );
    const hashSpan = html.match(/<span class="resolved-context-badge__hash"[^>]*>([^<]*)</)?.[1];
    expect(hashSpan).toBe("d752c85");
  });

  test("renders a 'no active project' state for source none", () => {
    const html = String(ResolvedContextBadge({ source: "none", displayName: null, projHash: null }));
    expect(html).toContain("no active project");
  });

  test("renders a 'no longer exists' state for source stale", () => {
    const html = String(ResolvedContextBadge({ source: "stale", displayName: null, projHash: null }));
    expect(html).toContain("no longer exists");
  });

  test("omits the hash span when projHash is null", () => {
    const html = String(ResolvedContextBadge({ source: "none", displayName: null, projHash: null }));
    expect(html).not.toContain("resolved-context-badge__hash");
  });
});
