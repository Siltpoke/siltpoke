// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The chat panel's "which agent answers" chip. The panel named the agent only
 * for a few seconds while another agent's reply was pending, and never for
 * claude — so after switching agents there was no way to see, in the panel,
 * that the switch had taken.
 *
 * DOM setup is top-level: the module calls `document.addEventListener` at
 * import time, and imports run before any hook.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:9876/" });

// Driven through the island the page registers ("chatAgent" on alpine:init),
// not through test-only exports (memory: a test-only export means the wrong
// thing was tested).
const factories: Record<string, () => unknown> = {};
(globalThis as { Alpine?: unknown }).Alpine = {
  data: (name: string, factory: () => unknown) => {
    factories[name] = factory;
  },
};
await import("../../../../src/web/client/islands/chat-agent-chip");
document.dispatchEvent(new Event("alpine:init"));

interface ChatAgentIsland {
  label: string;
  title: string;
  refresh(): Promise<void>;
}
function makeChatAgent(): ChatAgentIsland {
  const factory = factories.chatAgent;
  if (!factory) throw new Error("chatAgent island was not registered on alpine:init");
  return factory() as ChatAgentIsland;
}
/** What the chip shows after reading one `chat` value from GET /api/brain. */
async function chatAgentChip(chat: unknown): Promise<{ label: string; title: string }> {
  reply({ chat });
  const agent = makeChatAgent();
  await agent.refresh();
  return { label: agent.label, title: agent.title };
}

let calls: string[] = [];
function reply(body: unknown, status = 200): void {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

describe("chatAgentChip — what the chip says", () => {
  test("an agent with a model: family · model, and why in the tooltip", async () => {
    const chip = await chatAgentChip({ kind: "use", family: "claude", model: "claude-haiku-4-5-20251001", source: "installed" });
    // Short enough to read in the chip; the full id is in the tooltip.
    expect(chip.label).toBe("claude · haiku 4.5");
    expect(chip.title).toContain("claude-haiku-4-5-20251001");
    expect(chip.title).toContain("the only one found");
    expect(chip.title).toContain("Settings");
  });

  test("an agent with no model: the family alone, and the tooltip says its CLI picks the model", async () => {
    const chip = await chatAgentChip({ kind: "use", family: "codex", source: "chosen" });
    expect(chip.label).toBe("codex");
    expect(chip.title).toContain("you chose it");
    expect(chip.title).toContain("codex's own");
  });

  test("each reason has its own words", async () => {
    const why = async (source: string): Promise<string> => (await chatAgentChip({ kind: "use", family: "agy", source })).title;
    expect(new Set([await why("chosen"), await why("installed")]).size).toBe(2);
    expect(await why("installed")).toContain("only one");
    // "the one used last" is no longer a reason chat picks an agent (spec §11.1).
    expect(await why("recent")).not.toContain("used last");
  });

  test("several agents and nothing decided: says chat will ask, names none", async () => {
    const chip = await chatAgentChip({ kind: "choose", found: ["agy", "codex"] });
    expect(chip.label).toBe("will ask which agent");
    expect(chip.label).not.toMatch(/agy|codex/);
    expect(chip.title).toContain("ask");
  });

  test("a kind it does not know gives no chip even when a real agent is named", async () => {
    expect((await chatAgentChip({ kind: "later", family: "claude", source: "chosen" })).label).toBe("");
  });

  test("no agent on the machine", async () => {
    expect((await chatAgentChip({ kind: "none" })).label).toBe("no agent installed");
  });

  test("anything it does not recognise gives no chip — never a made-up name", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    for (const bad of [
      null,
      undefined,
      "claude",
      {},
      { kind: "use" },
      { kind: "use", family: hostile, source: "chosen" },
      { kind: "use", family: "claude", source: "installed", model: hostile },
      { kind: "other" },
    ]) {
      const chip = await chatAgentChip(bad);
      expect(chip.label).not.toContain("<");
      if (bad === null || typeof bad !== "object" || !("model" in bad)) expect(chip.label).toBe("");
    }
    // A model that is not a plain model id is dropped; the family still shows,
    // and the tooltip does not call a model it will not show "the default".
    const dropped = await chatAgentChip({ kind: "use", family: "claude", source: "installed", model: hostile });
    expect(dropped.label).toBe("claude");
    expect(dropped.title).not.toContain("own default");
    expect(dropped.title).toContain("not shown");
    expect(dropped.title).not.toContain("<");
  });

  test("a model id with brackets is a real id and is shown", async () => {
    const chip = await chatAgentChip({ kind: "use", family: "claude", source: "chosen", model: "claude-opus-4-8[1m]" });
    expect(chip.label).toBe("claude · opus 4.8[1m]");
  });

  test("short model: family prefix and date dropped, version dotted; other ids left alone", async () => {
    const label = async (family: string, model: string) =>
      (await chatAgentChip({ kind: "use", family, model, source: "chosen" })).label;
    expect(await label("claude", "claude-haiku-4-5-20251001")).toBe("claude · haiku 4.5");
    expect(await label("claude", "claude-sonnet-4-6")).toBe("claude · sonnet 4.6");
    expect(await label("claude", "claude-opus-4-8")).toBe("claude · opus 4.8");
    expect(await label("qoder", "qwen3-max")).toBe("qoder · qwen3-max");
    expect(await label("qoder", "qoder-turbo")).toBe("qoder · turbo");
    expect(await label("agy", "gemini-3-pro")).toBe("agy · gemini-3-pro");
    expect(await label("codebuddy", "glm-4-6-20250930")).toBe("codebuddy · glm 4.6");
  });
});

describe("chatAgent island", () => {
  test("refresh reads GET /api/brain and shows what chat will use", async () => {
    reply({ chat: { kind: "use", family: "qoder", source: "chosen" }, roles: [] });
    const agent = makeChatAgent();
    await agent.refresh();
    expect(calls).toEqual(["/api/brain"]);
    expect(agent.label).toBe("qoder");
    expect(agent.title).toContain("you chose it");
  });

  test("a later refresh replaces what was shown", async () => {
    const agent = makeChatAgent();
    reply({ chat: { kind: "use", family: "qoder", source: "chosen" } });
    await agent.refresh();
    reply({ chat: { kind: "use", family: "codebuddy", source: "installed" } });
    await agent.refresh();
    expect(agent.label).toBe("codebuddy");
  });

  test("a failed read clears the chip instead of leaving an old name up", async () => {
    const agent = makeChatAgent();
    reply({ chat: { kind: "use", family: "qoder", source: "chosen" } });
    await agent.refresh();
    reply("<html>bad gateway</html>", 502);
    await agent.refresh();
    expect(agent.label).toBe("");
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    reply({ chat: { kind: "use", family: "qoder", source: "chosen" } });
    await agent.refresh();
    expect(agent.label).toBe("qoder");
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await agent.refresh();
    expect(agent.label).toBe("");
  });

  test("an error status is not believed even when its body names an agent", async () => {
    reply({ chat: { kind: "use", family: "qoder", source: "chosen" } }, 500);
    const agent = makeChatAgent();
    await agent.refresh();
    expect(agent.label).toBe("");
  });

  test("an answer that arrives out of order does not overwrite a newer one", async () => {
    const agent = makeChatAgent();
    let releaseFirst: (r: Response) => void = () => {};
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n === 1) return new Promise<Response>((res) => (releaseFirst = res));
      return new Response(JSON.stringify({ chat: { kind: "use", family: "codex", source: "chosen" } }));
    }) as unknown as typeof fetch;
    const first = agent.refresh();
    await agent.refresh();
    expect(agent.label).toBe("codex");
    releaseFirst(new Response(JSON.stringify({ chat: { kind: "use", family: "agy", source: "installed" } })));
    await first;
    expect(agent.label).toBe("codex");
  });
});
