// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat route surfaces the index-staleness verdict whenever repo-graph was
 * queried (`deps.resolveAnchor` invoked), REGARDLESS of whether the resolve
 * actually returned any anchors/context — the zero-anchor blindspot (R10):
 * a heavily-stale or corrupt index that resolves to 0 anchors is exactly
 * when this warning matters most, so gating on "anchor resolved" would
 * silently drop it.
 *
 * Real fixture: `runIndexBuild` builds a genuine repo-graph index (same
 * harness as tests/cli/doctor-index-staleness.test.ts); `readIndexStaleness`
 * is never mocked. Only `resolveAnchor` (node resolution — orthogonal to
 * this surface) and `resolveProjectRootByHash` (proj_hash → project_root, a
 * cheap lookup normally backed by memory.json) are stubbed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ResolveAnchorResult } from "../../src/chat/anchor-context";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes, type ChatAnchorRef } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { runIndexBuild } from "../../src/repo-graph/builder";

const TEST_SECRET = "test-secret";
const PROJ_HASH = "deadbeef01234567";

const RESOLVED: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/a.ts:a",
    nodeName: "a",
    nodeType: "const",
    path: "src/a.ts",
    contextBundle: "SOURCE",
    systemPrompt: "SYS",
    fingerprint: "sha-a",
    includedSources: ["src/a.ts"],
    truncated: false,
  },
};

const ZERO_ANCHORS: ResolveAnchorResult = {
  kind: "node_not_found",
  target: { node_id: "function:src/a.ts:a" },
};

function fakeStream(_opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
  return (async function* () {
    yield { type: "message_start", message_id: "m-fake", model: "mock" };
    yield { type: "content_block_delta", text: "ok" };
    yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "ok" };
  })();
}

let home: string;
let repo: string;

function buildFixtureFiles(): void {
  mkdirSync(join(repo, "src"));
  for (const n of ["a", "b", "c", "d", "e"]) {
    writeFileSync(join(repo, "src", `${n}.ts`), `export const ${n}=1;\n`);
  }
}

function makeApp(resolveAnchor: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor,
    resolveProjectRootByHash: async (hash: string) => (hash === PROJ_HASH ? repo : null),
    secret: TEST_SECRET,
  });
  return a;
}

async function postChat(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
}

/** Parses the `event: staleness` SSE frame out of a drained response body
 * (or null if the frame never fired). */
function extractStaleness(sse: string): { level: string } | null {
  const marker = "event: staleness\ndata: ";
  const idx = sse.indexOf(marker);
  if (idx === -1) return null;
  const rest = sse.slice(idx + marker.length);
  const end = rest.indexOf("\n\n");
  return JSON.parse(end === -1 ? rest : rest.slice(0, end)) as { level: string };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-staleness-home-"));
  repo = mkdtempSync(join(tmpdir(), "siltpoke-chat-staleness-repo-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("chat surfaces staleness when repo-graph queried", () => {
  test("stale repo, anchors resolved → payload carries staleness", async () => {
    buildFixtureFiles();
    await runIndexBuild({ cwd: repo, force: true, home });
    // Edit 1/5 indexed files → meets the default staleness_warn_pct (0.2).
    writeFileSync(join(repo, "src", "a.ts"), "export const a=999;\n");

    const a = makeApp(async () => RESOLVED);
    const res = await postChat(a, {
      message: "hi",
      anchor: { node_id: "function:src/a.ts:a", proj_hash: PROJ_HASH },
    });
    const body = await res.text();
    const staleness = extractStaleness(body);
    expect(staleness).not.toBeNull();
    expect(staleness?.level).not.toBe("fresh");
  });

  test("stale repo, ZERO anchors → payload STILL carries staleness (R10)", async () => {
    buildFixtureFiles();
    await runIndexBuild({ cwd: repo, force: true, home });
    writeFileSync(join(repo, "src", "a.ts"), "export const a=999;\n");

    // resolveAnchor reports repo-graph WAS queried but returns zero anchors
    // (node_not_found) — this must NOT suppress the staleness surfacing.
    const a = makeApp(async () => ZERO_ANCHORS);
    const res = await postChat(a, {
      message: "hi",
      anchor: { node_id: "function:src/a.ts:a", proj_hash: PROJ_HASH },
    });
    const body = await res.text();
    const staleness = extractStaleness(body);
    expect(staleness).not.toBeNull();
    expect(staleness?.level).not.toBe("fresh");
  });

  test("fresh repo, anchor resolves → payload staleness is 'fresh' (this surface's own negative)", async () => {
    buildFixtureFiles();
    await runIndexBuild({ cwd: repo, force: true, home });
    // No edits after indexing — index reads as fresh.

    const a = makeApp(async () => RESOLVED);
    const res = await postChat(a, {
      message: "hi",
      anchor: { node_id: "function:src/a.ts:a", proj_hash: PROJ_HASH },
    });
    const body = await res.text();
    const staleness = extractStaleness(body);
    expect(staleness).not.toBeNull();
    expect(staleness?.level).toBe("fresh");
    // No non-fresh warning language leaked into the payload.
    expect(body).not.toContain("out of date");
    expect(body).not.toContain("drifted");
  });

  test("un-anchored send (no anchor field) → no staleness event at all", async () => {
    const a = makeApp(async () => ZERO_ANCHORS);
    const res = await postChat(a, { message: "hi, no anchor here" });
    const body = await res.text();
    expect(body).not.toContain("event: staleness");
  });

  test("mount without resolveProjectRootByHash (test compat / un-anchored back-compat) → no staleness event", async () => {
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED,
      // resolveProjectRootByHash intentionally absent
      secret: TEST_SECRET,
    });
    const res = await postChat(a, {
      message: "hi",
      anchor: { node_id: "function:src/a.ts:a", proj_hash: PROJ_HASH },
    });
    const body = await res.text();
    expect(body).not.toContain("event: staleness");
  });
});
