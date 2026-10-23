// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { describe, expect, test } from "bun:test";
import { SettingsModelWindow } from "../../../src/web/screens/SettingsModelWindow";
import { tokens } from "../../../src/web/tokens/tokens";

// Spec §12.2 — the markup of the Change-model window. Its behaviour is the
// modelPicker island's (tests/web/client/islands/model-picker.test.ts); the
// clicks are driven for real in tests/e2e/settings-agents.spec.ts.

const ROLES = {
  chat: { family: "qoder", model: "Qwen3.8-Max", why: "you chose it", isDefault: false },
  review: { family: "codex", model: "", why: "you chose it", isDefault: false },
  extract: { family: "claude", model: "claude-haiku-4-5", why: "Siltpoke's default", isDefault: true },
};
const html = String(<SettingsModelWindow secret="s3cret" roles={ROLES} />);
const tag = (re: RegExp) => html.match(re)?.[0] ?? "";

describe("SettingsModelWindow", () => {
  test("one modelPicker island carrying the secret and what each role uses now", () => {
    expect(html.match(/x-data="modelPicker"/g)?.length).toBe(1);
    const root = tag(/<div[^>]*x-data="modelPicker"[^>]*>/);
    expect(root).toContain('data-secret="s3cret"');
    const roles = JSON.parse(
      (root.match(/data-roles="([^"]*)"/)?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"),
    );
    expect(roles).toEqual(ROLES);
  });

  test("opened by the page's Change model buttons through a window event", () => {
    expect(tag(/<div[^>]*x-data="modelPicker"[^>]*>/)).toContain(
      'x-on:open-model-window.window="openFor($event.detail.role)"',
    );
  });

  test("closes on Esc, on ×, on Done and on the dimmed area — not on a click inside", () => {
    expect(html).toContain('x-on:keydown.escape.window="open &amp;&amp; close()"');
    expect(tag(/<div[^>]*data-model-backdrop[^>]*>/)).toContain('x-on:click.self="close()"');
    expect(tag(/<button[^>]*aria-label="Close"[^>]*>/)).toContain('x-on:click="close()"');
    expect(html).toMatch(/<button[^>]*x-on:click="close\(\)"[^>]*>Done<\/button>/);
  });

  test("no special options: no Follow, no Ask me in chat, no Back to default", () => {
    for (const gone of ["Follow the agent", "Ask me in chat", "Back to Siltpoke"]) expect(html).not.toContain(gone);
  });

  test("the in-use mark is a ✓ with aria-label in use and no words; other rows get Use", () => {
    const mark = tag(/<span[^>]*aria-label="in use"[^>]*>[^<]*<\/span>/);
    expect(mark).toContain('role="img"');
    expect(mark.replace(/<[^>]*>/g, "")).toBe("✓");
    expect(html).toMatch(/<button[^>]*x-on:click="use\(r\)"[^>]*>Use<\/button>/);
  });

  test("the table's columns and the tabs", () => {
    for (const th of ["Family", "Model", "What it's for", "In $/1M", "Out $/1M"]) {
      expect(html).toContain(`>${th.replace("'", "&#39;")}</th>`);
    }
    expect(html).toContain("Show models from:");
  });

  test("the footer says prices only sort and may not be what a plan charges", () => {
    expect(html).toContain("They only sort the list");
    expect(html).toContain("a subscription or plan may not charge this");
    expect(html).not.toContain("MOCK");
  });

  // "Agent" reads better as "Family", and it comes first.
  test("columns: Family, Model, What it's for, In, Out; a row's cells in the same order", () => {
    const heads = [...(html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "").matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]?.replace("&#39;", "'"));
    expect(heads).toEqual(["Family", "Model", "What it's for", "In $/1M", "Out $/1M", ""]);
    const row = html.match(/<tr data-model-row[\s\S]*?<\/tr>/)?.[0] ?? "";
    const firstCell = row.match(/<td[^>]*>/)?.[0] ?? "";
    expect(firstCell).toContain('x-text="r.family"');
  });

  // "What it's for" read "reasoning" on every row. The
  // maker's one-line description leads the cell; the footer says where it is from.
  test("What it's for leads with the model's description from models.dev", () => {
    const row = html.match(/<tr data-model-row[\s\S]*?<\/tr>/)?.[0] ?? "";
    const cells = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
    // the short line on top, tags under it; the full words on hover.
    expect(cells[2]).toMatch(/^<td[^>]*>\s*<div[^>]*>\s*<span[^>]*x-text="whatFor\(r\)"/);
    const short = cells[2]?.match(/<span[^>]*x-text="whatFor\(r\)"[^>]*>/)?.[0] ?? "";
    expect(short).toContain('x-bind:title="hoverFor(r)"');
    expect(cells[2]?.indexOf("whatFor(r)")).toBeLessThan(cells[2]?.indexOf("tagsFor(r)") ?? -1);
    expect(cells[2]).not.toContain("factsLine");
    // The page on openrouter.ai, in a new tab, never sending this page's address.
    const link = cells[2]?.match(/<a[^>]*>[^<]*<\/a>/)?.[0] ?? "";
    expect(link).toContain('x-show="r.guide"');
    expect(link).toContain('x-bind:href="r.guide ? r.guide.url : null"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toMatch(/>\s*↗\s*</);
    expect(link).toContain('aria-label="details on openrouter.ai"');
    expect(html).toContain("What it&#39;s for comes from openrouter.ai");
    expect(html).not.toContain("Tags (reasoning, tools, context size)");
  });

  // the two sites on one line, the agents on the next —
  // three to a row squeezed the dated site lines onto two lines each.
  test("source strip: a line for the sites, then a line for the agents", () => {
    const strip = html.match(/<div[^>]*data-model-sources[\s\S]*?<\/template>[\s\S]*?<\/template>/)?.[0] ?? "";
    const sites = strip.indexOf('x-for="s in sources(&#39;sites&#39;)"');
    const agents = strip.indexOf('x-for="s in sources(&#39;agents&#39;)"');
    expect(sites).toBeGreaterThan(-1);
    expect(agents).toBeGreaterThan(sites);
  });

  test("the In use now bar's model text comes from the island", () => {
    expect(html).toContain('x-text="inUseModelText()"');
    expect(html).not.toContain("model set in codex’s own config");
  });

  test("Use is offered only on a row that can be chosen and is not in use", () => {
    expect(html).toMatch(/<button[^>]*x-show="!isInUse\(r\) &amp;&amp; r\.choosable !== false"[^>]*x-on:click="use\(r\)"/);
  });

  // Same as the building chip: the green bar barely
  // read in light mode. Light-only fill; none in dark.
  test("the In use now bar carries the light-only green fill", () => {
    expect(tag(/<div[^>]*data-model-now[^>]*>/)).toContain(`background:${tokens.shadow.inUseWash}`);
  });
});
