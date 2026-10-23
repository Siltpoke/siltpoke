// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SettingsScreen — the Agents page in mock F's shape (spec agent-in-use-truth
 * §12.1; plan 2026-10-14 settings-agents-page-v2 Task 7): one line of agents
 * seen on this machine, then Chat / Critic / Summarizer with the model in use,
 * a daily cap with today's count, and Change model. The last-call lines are
 * AC7–AC11's.
 */
import { describe, expect, test } from "bun:test";
import type { BrainView } from "../../../src/cli/brain-cli";
import { SettingsScreen, type SettingsScreenProps } from "../../../src/web/screens/Settings";
import type { LastCall } from "../../../src/web/screens/settings-last-calls";
import { shadowPalette } from "../../../src/web/tokens/palette";
import { tokens } from "../../../src/web/tokens/tokens";

import { CAPS, NO_CALLS, NOW, SECRET, VIEW } from "./settings-fixture";

function render(over: Partial<SettingsScreenProps> = {}): string {
  // Single quotes un-escaped, as the browser reads the attributes.
  return String(<SettingsScreen view={VIEW} secret={SECRET} caps={CAPS} last={NO_CALLS} now={NOW} {...over} />).replace(
    /&#39;/g,
    "'",
  );
}

/** One role row: from its marker to the next row (or the end of the table). */
function roleRow(html: string, role: string): string {
  const start = html.search(new RegExp(`data-role-row="${role}"`));
  const rest = html.slice(start);
  const next = rest.slice(1).search(/data-role-row="|data-model-backdrop/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const text = (html: string): string =>
  html
    .replace(/<template[\s\S]*?<\/template>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** 2026-10-14 19:58 local — the same day as NOW. */
const SAME_DAY = new Date(2026, 9, 14, 19, 58).toISOString();

describe("Settings — page shape (§12.1)", () => {
  test("Dashboard shell, heading Agents, two blocks in order", () => {
    const t = text(render());
    expect(t).toContain("Agents");
    expect(t.indexOf("Coding agents on this machine")).toBeGreaterThan(-1);
    expect(t.indexOf("Siltpoke's own agents")).toBeGreaterThan(t.indexOf("Coding agents on this machine"));
  });

  test("no dropdowns anywhere, no separate Daily call caps block, no what's this", () => {
    const html = render();
    expect(html).not.toContain("<select");
    expect(text(html)).not.toContain("Daily call caps");
    expect(text(html).toLowerCase()).not.toContain("what's this");
  });

  test("three Change model buttons, one per role, each opening the window for its role", () => {
    const html = render();
    const buttons = html.match(/<button[^>]*>\s*Change model\s*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const role of ["chat", "review", "extract"]) {
      expect(roleRow(html, role)).toContain(`$dispatch('open-model-window', { role: '${role}' })`);
    }
  });

  test("one Change-model window on the page", () => {
    expect(render().match(/x-data="modelPicker"/g)?.length).toBe(1);
  });
});

describe("Settings — codex's model on the row", () => {
  test("a codex row names the model codex's own config sets", () => {
    const view: BrainView = {
      ...VIEW,
      roles: VIEW.roles.map((r) => (r.role === "review" ? { role: "review", family: "codex", source: "pinned here" } : r)),
    };
    expect(text(roleRow(render({ view, codexModel: "gpt-5.6-sol" }), "review"))).toContain(
      "codex gpt-5.6-sol, from codex's config",
    );
  });

  // Review 5, [1]: the window's bar says the same before its list loads.
  test("the window is handed the row's words for an agent on its own model; a named model needs none", () => {
    const view: BrainView = {
      ...VIEW,
      roles: VIEW.roles.map((r) => (r.role === "review" ? { role: "review", family: "codex", source: "pinned here" } : r)),
    };
    const root = render({ view, codexModel: "gpt-5.6-sol" }).match(/<div[^>]*x-data="modelPicker"[^>]*>/)?.[0] ?? "";
    const roles = JSON.parse((root.match(/data-roles="([^"]*)"/)?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    expect(roles.review.modelText).toBe("gpt-5.6-sol, from codex's config");
    expect(roles.extract.modelText).toBeUndefined();
  });
});

describe("Settings — coding agents on this machine (§12.1, §12.4)", () => {
  const chip = (html: string, family: string) =>
    text(html.match(new RegExp(`<span[^>]*data-agent-chip="${family}"[^>]*>[\\s\\S]*?</span>\\s*</span>`))?.[0] ?? "");

  test("seen → building and when; installed → installed; not installed → dimmed", () => {
    const html = render();
    expect(chip(html, "claude")).toBe("claude building · 19:40");
    expect(chip(html, "agy")).toBe("agy installed");
    expect(chip(html, "codebuddy")).toBe("codebuddy not installed");
    expect(html).toMatch(/data-agent-chip="codebuddy"[^>]*data-state="off"/);
    expect(html).toMatch(/data-agent-chip="claude"[^>]*data-state="on"/);
  });

  // Mock F: building = green dot, installed = grey dot, not installed = no dot
  // (the maintainer on the real page, 2026-10-15: the building chip had no green).
  test("building has a green dot, installed a grey dot, not installed none", () => {
    const html = render();
    const dot = (family: string) =>
      html.match(new RegExp(`data-agent-chip="${family}"[^>]*>\\s*<span[^>]*data-chip-dot="([a-z]+)"[^>]*>`))?.[1];
    expect(dot("claude")).toBe("on");
    expect(dot("agy")).toBe("idle");
    expect(dot("codebuddy")).toBeUndefined();
    const style = (state: string) => html.match(new RegExp(`data-chip-dot="${state}"[^>]*style="([^"]*)"`))?.[1] ?? "";
    expect(style("on")).toContain(`background:${tokens.color.moss}`);
    expect(style("idle")).toContain(`background:${tokens.color.ink3}`);
  });

  // Light mode: moss on cream barely read as green. The
  // building chip gets a wash — light only; she wanted none in dark — and the
  // dot a moss halo; other chips none.
  test("the building chip is tinted green in light mode only; an installed chip is not", () => {
    const html = render();
    const chipStyle = (family: string) =>
      html.match(new RegExp(`<span[^>]*data-agent-chip="${family}"[^>]*style="([^"]*)"`))?.[1] ?? "";
    expect(chipStyle("claude")).toContain(`background:${tokens.shadow.inUseWash}`);
    expect(chipStyle("agy")).not.toContain("inUseWash");
    expect(shadowPalette.light.inUseWash).toMatch(/^rgba\(/);
    expect(shadowPalette.dark.inUseWash).toBe("transparent");
    const onDot = html.match(/data-chip-dot="on"[^>]*style="([^"]*)"/)?.[1] ?? "";
    expect(onDot).toContain(`box-shadow:0 0 0 3px color-mix(in srgb, ${tokens.color.moss}`);
  });

  test("several can be building at once; another day shows the date", () => {
    const view: BrainView = {
      ...VIEW,
      agents: VIEW.agents.map((a) =>
        a.family === "codex" ? { ...a, seenAt: new Date(2026, 9, 13, 8, 5).toISOString() } : a,
      ),
    };
    const html = render({ view });
    expect(chip(html, "claude")).toBe("claude building · 19:40");
    expect(chip(html, "codex")).toBe("codex building · 2026-10-13 08:05");
  });

  test("the chips are read-only: no button or input among them", () => {
    const bar = render().match(/data-agents-bar[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(bar).not.toMatch(/<button|<input/);
  });
});

describe("Settings — Siltpoke's own agents (§12.1)", () => {
  test("rows in order Chat, Critic, Summarizer with what each does", () => {
    const t = text(render());
    const order = ["Chat", "Critic", "Summarizer"].map((n) => t.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(t).toContain("answers you in the dashboard chat");
    expect(t).toContain("reviews your code after each turn");
    expect(t).toContain("writes summaries and extracts memories");
  });

  test("Using: the agent and its model; the reason says who chose it", () => {
    const html = render();
    const review = text(roleRow(html, "review"));
    expect(review).toContain("qoder qoder-turbo");
    expect(review).toContain("you chose it");
    const extract = text(roleRow(html, "extract"));
    expect(extract).toContain("claude claude-haiku-4-5-20251001");
    expect(extract).toContain("Siltpoke's default — does not copy the model you use yourself");
    const chat = text(roleRow(html, "chat"));
    expect(chat).toContain("qoder");
    expect(chat).toContain("the only agent installed");
  });

  // Review 3, [1]: an unpinned critic runs on the agent the user builds with
  // (brain-config: review_by_builder ?? host family) — never claude by default.
  test("Critic not chosen: it follows the agent you build with, and no window row is marked in use", () => {
    const view: BrainView = {
      ...VIEW,
      roles: VIEW.roles.map((r) =>
        r.role === "review" ? { role: "review", family: "claude", model: "claude-haiku-4-5", source: "default" } : r,
      ),
    };
    const html = render({ view });
    const t = text(roleRow(html, "review"));
    expect(t).toContain("the agent you build with");
    expect(t).not.toContain("claude claude-haiku-4-5");
    const roles = JSON.parse(
      (html.match(/data-roles="([^"]*)"/)?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    );
    expect(roles.review.family).toBe("");
    expect(roles.review.label).toBe("the agent you build with");
  });

  test("never names the builder's model as the default's reason", () => {
    expect(text(render())).not.toMatch(/does not copy (your )?(Opus|Sonnet|Haiku|claude-)/i);
  });

  test("an agent with no model of its own named: its own default model; codex: its own config", () => {
    const view: BrainView = {
      ...VIEW,
      roles: VIEW.roles.map((r) =>
        r.role === "review" ? { role: "review", family: "codex", source: "pinned here" } : r.role === "extract"
          ? { role: "extract", family: "agy", source: "pinned here" } : r,
      ),
    };
    const html = render({ view });
    expect(text(roleRow(html, "review"))).toContain("codex model set in codex's own config");
    expect(text(roleRow(html, "extract"))).toContain("agy its own default model");
  });

  test("chat with more than one agent and none chosen: not chosen, chat will ask", () => {
    const view: BrainView = { ...VIEW, chat: { kind: "choose", found: ["agy", "qoder"] } };
    const t = text(roleRow(render({ view }), "chat"));
    expect(t).toContain("not chosen");
    expect(t).toContain("chat will ask which agent");
  });

  test("chat with no agent at all: says so", () => {
    const view: BrainView = { ...VIEW, chat: { kind: "none" } };
    expect(text(roleRow(render({ view }), "chat"))).toContain("no coding agent installed");
  });
});

describe("Settings — daily cap per role (§12.1, §12.3)", () => {
  test("one dailyCaps island carrying the secret and the three caps in effect", () => {
    const html = render();
    expect(html.match(/x-data="dailyCaps"/g)?.length).toBe(1);
    const root = html.match(/<[^>]*x-data="dailyCaps"[^>]*>/)?.[0] ?? "";
    expect(root).toContain(`data-secret="${SECRET}"`);
    expect(root).toContain('data-chat="50"');
    expect(root).toContain('data-review="50"');
    expect(root).toContain('data-extract="0"');
  });

  test("each row's field is bound to its role, saves on leave and on Enter, and shows / day", () => {
    const html = render();
    for (const role of ["chat", "review", "extract"]) {
      const row = roleRow(html, role);
      const input = row.match(/<input[^>]*>/)?.[0] ?? "";
      expect(input).toContain(`x-model="values.${role}"`);
      expect(input).toContain(`x-on:blur="saveOne('${role}')"`);
      expect(input).toContain(`x-on:keydown.enter="saveOne('${role}')"`);
      expect(input).toContain(`x-on:input="touched('${role}')"`);
      expect(text(row)).toContain("/ day");
      expect(row).toContain(`x-show="flash.${role}"`);
      expect(row).toContain(`x-text="errors.${role}"`);
    }
  });

  test("N used today under each field", () => {
    const html = render();
    expect(text(roleRow(html, "chat"))).toContain("20 used today");
    expect(text(roleRow(html, "review"))).toContain("12 used today");
    expect(text(roleRow(html, "extract"))).toContain("3 used today");
  });

  // a chat just sent did not move "0 used today".
  // The island carries today's counts, re-reads them on its own, and the text
  // and the meter follow its numbers — not the ones the page was rendered with.
  test("today's counts live in the island, which keeps them fresh; text and meter follow", () => {
    const html = render();
    const root = html.match(/<[^>]*x-data="dailyCaps"[^>]*>/)?.[0] ?? "";
    expect(root).toContain('data-chat-used="20"');
    expect(root).toContain('data-review-used="12"');
    expect(root).toContain('data-extract-used="3"');
    expect(root).toContain('x-init="startPolling()"');
    expect(root).toContain('x-on:visibilitychange.document="refreshUsage()"');
    for (const role of ["chat", "review", "extract"]) {
      const row = roleRow(html, role);
      expect(row).toContain(`x-text="usedText('${role}')"`);
      expect(row).toMatch(new RegExp(`data-cap-meter="${role}"[^>]*x-bind:style="[^"]*used\\.${role}`));
    }
  });

  // Review 3, [4]: a cap of 0 must not read as "capped at 0".
  test("a cap of 0 says there is no cap", () => {
    const t = text(roleRow(render(), "extract"));
    expect(t).toContain("no cap · 3 used today");
    expect(text(roleRow(render(), "chat"))).not.toContain("no cap");
  });

  test("no Save button on the page", () => {
    expect(render()).not.toMatch(/<button[^>]*>\s*Save\s*<\/button>/);
  });
});

describe("Settings — what the records say happened last (AC7–AC11)", () => {
  const chat: LastCall = { family: "claude", model: "claude-haiku-4-5-20251001", requested: "claude-haiku-4-5", at: SAME_DAY, outcome: "ok" };
  const review: LastCall = { family: "qoder", model: null, requested: null, at: SAME_DAY, outcome: "ok" };

  test("Chat: last answer names the agent and model it reported, and when", () => {
    const t = text(roleRow(render({ last: { chat, review: null } }), "chat"));
    expect(t).toContain("last answer: claude · claude-haiku-4-5-20251001 at 19:58");
  });

  test("Chat: a failed or stopped last call is not called an answer", () => {
    const failed = text(roleRow(render({ last: { chat: { ...chat, outcome: "failed" }, review: null } }), "chat"));
    expect(failed).toContain("last chat call failed: claude at 19:58");
    expect(failed).not.toContain("last answer");
    const stopped = text(roleRow(render({ last: { chat: { ...chat, outcome: "cancelled" }, review: null } }), "chat"));
    expect(stopped).toContain("last chat call was stopped: claude at 19:58");
  });

  test("Chat: a last call with no agent decided says so — not 'no answer recorded yet'", () => {
    const t = text(
      roleRow(render({ last: { chat: { ...chat, family: null, model: null, outcome: "failed" }, review: null } }), "chat"),
    );
    expect(t).toContain("last chat call: no agent was decided at 19:58");
    expect(t).not.toContain("no answer recorded yet");
    expect(t).not.toContain("null");
  });

  test("Chat with no record → no answer recorded yet", () => {
    expect(text(roleRow(render(), "chat"))).toContain("no answer recorded yet");
  });

  test("Critic: a review row with no model says the agent did not report it — never 'model not reported'", () => {
    const t = text(roleRow(render({ last: { chat: null, review } }), "review"));
    expect(t).toContain("last review: qoder at 19:58 · qoder did not report which model it used");
    expect(t).not.toContain("model not reported");
  });

  test("Chat: no reported model → names what Settings chose and that the agent did not report the one it used", () => {
    const t = text(
      roleRow(render({ last: { chat: { ...chat, family: "qoder", model: null, requested: "lite" }, review: null } }), "chat"),
    );
    expect(t).toContain("last answer: qoder at 19:58 · Settings chose lite; qoder did not report which model it actually used");
    expect(t).not.toContain("model not reported");
  });

  test("Chat: no reported model and none asked for (or an empty one) → only that the agent did not report it", () => {
    for (const requested of [null, ""]) {
      const t = text(
        roleRow(render({ last: { chat: { ...chat, family: "qoder", model: null, requested }, review: null } }), "chat"),
      );
      expect(t).toContain("last answer: qoder at 19:58 · qoder did not report which model it used");
      expect(t).not.toContain("Settings chose");
    }
  });

  test("Critic: a review row with no agent names it once, the same way", () => {
    const t = text(roleRow(render({ last: { chat: null, review: { ...review, family: null } } }), "review"));
    expect(t).toContain("last review: an unnamed agent at 19:58 · an unnamed agent did not report which model it used");
  });

  test("Critic with no record → no review recorded yet", () => {
    expect(text(roleRow(render(), "review"))).toContain("no review recorded yet");
  });

  test("the last line reads the record, not the setting", () => {
    const t = text(roleRow(render({ last: { chat: null, review: { ...review, family: "agy" } } }), "review"));
    expect(t).toContain("last review: agy");
  });

  test("Summarizer says no call is recorded yet", () => {
    expect(text(roleRow(render(), "extract"))).toContain("no summarizer call is recorded yet");
  });
});
