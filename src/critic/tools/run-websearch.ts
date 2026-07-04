// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { WebSource } from "../../brain/schema-v2";

export interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export interface WebSearchResult {
  sources: WebSource[];
  used: boolean;
  cached?: boolean;
}

export type WebSearchClient = (query: string, maxResults: number) => Promise<WebSource[]>;

/**
 * Real Anthropic SDK client (lazy-loaded to avoid hard dependency).
 * Returns null when ANTHROPIC_API_KEY is not set or SDK is not installed.
 */
export async function createAnthropicWebSearchClient(): Promise<WebSearchClient | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    // @ts-ignore - SDK dynamically imported; may not be installed
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: key });
    return async (query: string, maxResults: number): Promise<WebSource[]> => {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        tools: [{ type: "web_search_20250305" as const, name: "web_search", max_uses: maxResults }],
        messages: [{ role: "user", content: `Search the web: ${query}\nReturn 1-${maxResults} top sources with title, snippet, url.` }],
      });
      // Extract web search results from response content blocks
      const sources: WebSource[] = [];
      for (const block of response.content) {
        if (block.type === "web_search_tool_result") {
          // @ts-ignore - shape per Anthropic docs
          for (const item of (block.content ?? []) as Array<{ url?: string; title?: string; encrypted_content?: string }>) {
            if (item.url && item.title) {
              sources.push({
                url: item.url,
                title: item.title.slice(0, 200),
                snippet: (item.encrypted_content ?? "").slice(0, 500),
                query: query.slice(0, 200),
              });
            }
          }
        }
      }
      return sources;
    };
  } catch {
    return null;
  }
}

/**
 * Run a web search using the provided client or a lazily-created Anthropic client.
 * Returns empty sources (used: false) if no client is available or the client throws.
 */
export async function runWebSearch(
  input: WebSearchInput,
  opts: { client?: WebSearchClient } = {},
): Promise<WebSearchResult> {
  const client = opts.client ?? await createAnthropicWebSearchClient();
  if (!client) return { sources: [], used: false };
  try {
    const sources = await client(input.query, input.maxResults ?? 3);
    return { sources, used: true };
  } catch {
    return { sources: [], used: false };
  }
}
