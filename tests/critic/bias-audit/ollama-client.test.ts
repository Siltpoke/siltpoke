import { describe, test, expect, mock } from "bun:test";
import { callOllama } from "../../../src/critic/bias-audit/ollama-client";

describe("callOllama", () => {
  test("returns null when fetch response is not ok", async () => {
    const mockFetch = mock(async () => ({ ok: false } as Response));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await callOllama("test-model", { system: "sys", user: "usr" }, {
      endpoint: "http://localhost:11434/api/generate",
    });
    expect(result).toBeNull();
  });

  test("returns null when response has no .response field", async () => {
    const mockFetch = mock(async () => ({
      ok: true,
      json: async () => ({}),
    } as Response));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await callOllama("test-model", { system: "sys", user: "usr" }, {
      endpoint: "http://localhost:11434/api/generate",
    });
    expect(result).toBeNull();
  });

  test("parses valid JSON response correctly", async () => {
    const verdict = {
      severity: "med",
      confidence: "high",
      category: "correctness",
      reasoning: "looks wrong to me",
    };
    const mockFetch = mock(async () => ({
      ok: true,
      json: async () => ({ response: JSON.stringify(verdict) }),
    } as Response));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await callOllama("test-model", { system: "sys", user: "usr" }, {
      endpoint: "http://localhost:11434/api/generate",
    });
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("med");
    expect(result?.confidence).toBe("high");
    expect(result?.category).toBe("correctness");
    expect(result?.reasoning).toBe("looks wrong to me");
  });

  test("returns null when fetch throws (network error)", async () => {
    const mockFetch = mock(async () => {
      throw new Error("network error");
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await callOllama("test-model", { system: "sys", user: "usr" }, {
      endpoint: "http://localhost:11434/api/generate",
    });
    expect(result).toBeNull();
  });

  test("sends correct model and prompt body", async () => {
    let capturedBody: string | null = null;
    const mockFetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string ?? null;
      return {
        ok: true,
        json: async () => ({ response: JSON.stringify({ severity: "info", confidence: "low", category: "design", reasoning: "ok" }) }),
      } as Response;
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await callOllama("qwen2.5-coder:7b", { system: "SYSTEM", user: "USER" }, {
      endpoint: "http://localhost:11434/api/generate",
    });

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!) as { model: string; stream: boolean };
    expect(parsed.model).toBe("qwen2.5-coder:7b");
    expect(parsed.stream).toBe(false);
  });
});
