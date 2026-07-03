import { test, expect, describe } from "bun:test";
import { runWebSearch } from "../../../src/critic/tools/run-websearch";
import type { WebSearchClient } from "../../../src/critic/tools/run-websearch";
import type { WebSource } from "../../../src/brain/schema-v2";

const makeSources = (n: number): WebSource[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Result ${i}`,
    snippet: `Snippet for result ${i}`,
    query: "test query",
  }));

describe("runWebSearch", () => {
  test("mock client returns sources and used=true", async () => {
    const expected = makeSources(2);
    const mockClient: WebSearchClient = async (_query, _max) => expected;

    const result = await runWebSearch({ query: "test query" }, { client: mockClient });

    expect(result.used).toBe(true);
    expect(result.sources).toEqual(expected);
  });

  test("null client (no API key) returns empty sources and used=false", async () => {
    // Provide no client; createAnthropicWebSearchClient will return null
    // because ANTHROPIC_API_KEY is not set in test env (or we simulate null)
    const _nullClient = null as unknown as WebSearchClient;
    // Override: pass undefined opts so it falls through to createAnthropicWebSearchClient
    // We simulate by passing a client that is undefined — no opts at all
    // But since ANTHROPIC_API_KEY is not expected in test, we instead
    // pass an explicitly null-returning approach via a typed shim.
    // Simplest: use opts with client=undefined and delete env key temporarily.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await runWebSearch({ query: "test query" });
      expect(result.used).toBe(false);
      expect(result.sources).toEqual([]);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  test("client that throws returns empty sources and used=false", async () => {
    const throwingClient: WebSearchClient = async () => {
      throw new Error("network error");
    };

    const result = await runWebSearch({ query: "failing query" }, { client: throwingClient });

    expect(result.used).toBe(false);
    expect(result.sources).toEqual([]);
  });

  test("respects maxResults from input", async () => {
    let capturedMax = 0;
    const mockClient: WebSearchClient = async (_query, max) => {
      capturedMax = max;
      return makeSources(max);
    };

    await runWebSearch({ query: "query", maxResults: 5 }, { client: mockClient });
    expect(capturedMax).toBe(5);
  });

  test("defaults maxResults to 3", async () => {
    let capturedMax = 0;
    const mockClient: WebSearchClient = async (_query, max) => {
      capturedMax = max;
      return [];
    };

    await runWebSearch({ query: "query" }, { client: mockClient });
    expect(capturedMax).toBe(3);
  });
});
