/**
 * Dashboard chat reads the user's project: claude runs with the project root
 * as its working directory and is told it may read there (src/chat/repo-access.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { codeMapViewContext, parseCodeMapView } from "../../src/chat/page-view";
import { composeChatPrompt } from "../../src/chat/prompt-blocks";
import {
  answersWithClaude,
  chatProjectRoot,
  NO_CODE_ACCESS_BLOCK,
  noCodeAccessFor,
  repoAccessBlock,
} from "../../src/chat/repo-access";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { type StreamChatOptions, type StreamEvent, streamChat } from "../../src/daemon/routes/chat-stream";
import { GLOBAL_ONLY } from "../../src/memory/memory";

const SECRET = "test-secret";
const PINNED = process.cwd();
const PROJ = tmpdir();
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("where a chat turn runs", () => {
  const resolve = async (h: string) => (h === "abc123" ? PROJ : null);

  test("a pinned conversation's project wins; else the Code Map's open project; else nowhere", async () => {
    expect(await chatProjectRoot(PINNED, "abc123", resolve)).toBe(PINNED);
    expect(await chatProjectRoot(GLOBAL_ONLY, "abc123", resolve)).toBe(PROJ);
    expect(await chatProjectRoot(GLOBAL_ONLY, "ffffff", resolve)).toBeUndefined();
    expect(await chatProjectRoot(GLOBAL_ONLY, undefined, resolve)).toBeUndefined();
    expect(await chatProjectRoot(GLOBAL_ONLY, "abc123", undefined)).toBeUndefined();
    const throws = async () => {
      throw new Error("io");
    };
    expect(await chatProjectRoot(GLOBAL_ONLY, "abc123", throws)).toBeUndefined();
    // A project moved or deleted since it was indexed: run where chat always ran.
    const gone = join(tmpdir(), "siltpoke-no-such-project-7731");
    expect(await chatProjectRoot(gone, undefined, resolve)).toBeUndefined();
    expect(await chatProjectRoot(GLOBAL_ONLY, "abc123", async () => gone)).toBeUndefined();
  });

  test("claude only: no resolver (= claude) or a claude pick; never another agent", () => {
    expect(answersWithClaude(undefined)).toBe(true);
    expect(answersWithClaude({ kind: "use", family: "claude", source: "settings" } as never)).toBe(true);
    expect(answersWithClaude({ kind: "use", family: "codex", source: "settings" } as never)).toBe(false);
    expect(answersWithClaude({ kind: "none" } as never)).toBe(false);
  });

  test("the block names the folder and forbids describing code from a name", () => {
    const b = repoAccessBlock(PROJ);
    expect(b).toContain(`Your working directory is its root (${PROJ})`);
    expect(b).toContain("read the files you need before you answer");
    expect(b).toContain("Never describe what code does from a name alone");
  });

  test("the files a view lists are marked as paths only", () => {
    const view = parseCodeMapView({ repo: "r", selection: { kind: "component", title: "C", files: ["src/a.ts"] } });
    expect(view).not.toBeNull();
    if (view) expect(codeMapViewContext(view).contextBundle).toContain("Files (paths only; their contents are not shown here):\n- src/a.ts");
  });

  test("the view carries a well-formed project hash only", () => {
    expect(parseCodeMapView({ repo: "r", selection: null, proj_hash: "998ff95d3467" })?.projHash).toBe("998ff95d3467");
    expect(parseCodeMapView({ repo: "r", selection: null, proj_hash: "../../etc" })?.projHash).toBeUndefined();
    expect(parseCodeMapView({ repo: "r", selection: null })?.projHash).toBeUndefined();
  });

  test("the block is sent right after the page context, and is not listed as left out when absent", () => {
    const base = { page: "P", userFacts: "", episodes: "", captureHonesty: "", captureMarker: "", recall: "", transcript: "t" };
    const withIt = composeChatPrompt({ ...base, repoAccess: "R" });
    expect(withIt.systemPrompt).toBe("P\n\nR");
    expect(withIt.blocks.map((b) => b.name)).toEqual(["page context", "reading your project", "conversation"]);
    const without = composeChatPrompt({ ...base, repoAccess: "" });
    expect(without.systemPrompt).toBe("P");
    expect(without.omitted).not.toContain("reading your project");
    const noAccess = composeChatPrompt({ ...base, noCodeAccess: "N" });
    expect(noAccess.systemPrompt).toBe("P\n\nN");
    expect(noAccess.blocks.map((b) => b.name)).toEqual(["page context", "no access to your files", "conversation"]);
    expect(without.omitted).not.toContain("no access to your files");
  });
});

describe("the spawn: claude starts in the folder it is given", () => {
  async function spawnOpts(cwd?: string): Promise<{ cwd?: string } | undefined> {
    let seen: { cwd?: string } | undefined;
    const spawnFn = ((_args: string[], opts: { cwd?: string }) => {
      seen = opts;
      throw new Error("stop here");
    }) as unknown as typeof Bun.spawn;
    for await (const _ of streamChat({ transcript: "hi", spawnFn, ...(cwd ? { cwd } : {}) })) {
      // the spawn failure is the only event
    }
    return seen;
  }

  test("cwd given → the process runs there; none → no cwd option at all", async () => {
    expect((await spawnOpts(PROJ))?.cwd).toBe(PROJ);
    const none = await spawnOpts();
    expect(none).toBeDefined();
    expect(none && "cwd" in none).toBe(false);
  });
});

describe("delivery: the route runs claude in the Code Map's open project", () => {
  async function send(view: unknown, resolveChatProvider?: () => unknown, page = "/repo-graph"): Promise<StreamChatOptions | undefined> {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-repo-access-"));
    homes.push(home);
    let seen: StreamChatOptions | undefined;
    const stream = async function* (opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
      seen = opts;
      yield { type: "message_start", message_id: "m-1", model: "mock" } as StreamEvent;
      yield { type: "content_block_delta", text: "ok" } as StreamEvent;
      yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "ok" } as StreamEvent;
    };
    const app = new Hono();
    mountChatRoutes(app, {
      resolveProject: async () => ({ project_id: null, proj_hash: null, project_root: null, display_name: null, source: "explicit" as const }),
      homeBase: home,
      index: openIndex(home),
      secret: SECRET,
      streamFactory: stream,
      resolveProjectRootByHash: async (h: string) => (h === "abc123" ? PROJ : null),
      ...(resolveChatProvider ? { resolveChatProvider } : {}),
    } as never);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
      body: JSON.stringify({ message: "what is in utils?", page, view }),
    });
    await res.text();
    return seen;
  }

  test("an open project: cwd is its root and the prompt says it may read there", async () => {
    const opts = await send({ repo: "proj", selection: null, proj_hash: "abc123" });
    expect(opts?.cwd).toBe(PROJ);
    expect(opts?.systemPrompt).toContain(`Your working directory is its root (${PROJ})`);
  });

  test("no project: no cwd, no reading block", async () => {
    const opts = await send({ repo: "proj", selection: null });
    expect(opts?.cwd).toBeUndefined();
    expect(opts?.systemPrompt ?? "").not.toContain("You can read the user's project");
  });

  // A2: a code question on a turn that cannot open files says so, and does not guess from names.
  test("Code Map, no project: the no-access block is sent", async () => {
    const opts = await send({ repo: "proj", selection: null });
    expect(opts?.systemPrompt ?? "").toContain(NO_CODE_ACCESS_BLOCK);
  });

  test("which turns get the no-access block", () => {
    // Another agent answers or no project → no cwd → the block, on the Code Map, unpinned.
    expect(noCodeAccessFor(undefined, false, "/repo-graph")).toBe(NO_CODE_ACCESS_BLOCK);
    // A pinned turn carries its code (a node's source, a review's diff): never "not seen".
    expect(noCodeAccessFor(undefined, true, "/repo-graph")).toBe("");
    expect(noCodeAccessFor(undefined, true, "/timeline")).toBe("");
    expect(noCodeAccessFor(undefined, false, "/timeline")).toBe("");
    expect(noCodeAccessFor(PROJ, false, "/repo-graph")).toBe("");
  });

  test("Code Map, claude reads the project: no no-access block", async () => {
    const opts = await send({ repo: "proj", selection: null, proj_hash: "abc123" });
    expect(opts?.systemPrompt ?? "").not.toContain("You cannot open the user's files");
  });

  test("Home page, unpinned: no no-access block (nobody asked about code)", async () => {
    const opts = await send(undefined, undefined, "/");
    expect(opts).toBeDefined();
    expect(opts?.systemPrompt ?? "").not.toContain("You cannot open the user's files");
  });
});
