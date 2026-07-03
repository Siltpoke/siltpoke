import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyProject,
  writeProject,
  listActiveProjects,
  type ResolvedProject,
} from "../../src/memory/project";
import type { ChatSession } from "../../src/memory/memory";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function resolved(id: string, root: string, name: string): ResolvedProject {
  return { project_id: id, project_root: root, display_name: name, source: "git" };
}

function chat(over: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    id: over.id,
    started_at: over.started_at ?? "2026-06-01T00:00:00Z",
    ended_at: over.ended_at ?? null,
    message_count: over.message_count ?? 2,
    summary: over.summary ?? "",
    summary_generated_at: over.summary_generated_at ?? null,
    tags: over.tags ?? [],
    anchor: over.anchor ?? null,
  };
}

async function seed(
  id: string,
  name: string,
  opts: { consolidatedAt: string; longTerm?: string; chats?: ChatSession[] },
): Promise<void> {
  const p = emptyProject(resolved(id, `/code/${name}`, name));
  p.last_consolidated_at = opts.consolidatedAt;
  p.long_term_summary = opts.longTerm ?? "";
  p.chat_sessions = opts.chats ?? [];
  await writeProject(home, id, p);
}

describe("listActiveProjects", () => {
  test("returns [] when no projects dir exists", async () => {
    expect(await listActiveProjects(home)).toEqual([]);
  });

  test("returns one entry per project with core fields", async () => {
    await seed("aaa", "siltpoke", { consolidatedAt: "2026-06-20T10:00:00Z" });
    const list = await listActiveProjects(home);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      project_id: "aaa",
      project_root: "/code/siltpoke",
      display_name: "siltpoke",
      chat_count: 0,
    });
  });

  test("sorts newest-active first", async () => {
    await seed("old", "old-app", { consolidatedAt: "2026-06-01T00:00:00Z" });
    await seed("new", "new-app", { consolidatedAt: "2026-06-25T00:00:00Z" });
    await seed("mid", "mid-app", { consolidatedAt: "2026-06-10T00:00:00Z" });
    const list = await listActiveProjects(home);
    expect(list.map((p) => p.display_name)).toEqual(["new-app", "mid-app", "old-app"]);
  });

  test("a project with no consolidation and no timestamped chats sorts last", async () => {
    await seed("dated", "dated-app", { consolidatedAt: "2026-06-10T00:00:00Z" });
    await seed("blank", "blank-app", { consolidatedAt: "" });
    const list = await listActiveProjects(home);
    expect(list.map((p) => p.display_name)).toEqual(["dated-app", "blank-app"]);
    expect(list.find((p) => p.display_name === "blank-app")?.last_active_at).toBe("");
  });

  test("last_active_at is max(last_consolidated_at, newest chat ts)", async () => {
    await seed("aaa", "app", {
      consolidatedAt: "2026-06-01T00:00:00Z",
      chats: [
        chat({ id: "c1", ended_at: "2026-06-15T08:00:00Z" }),
        chat({ id: "c2", ended_at: "2026-06-22T09:30:00Z" }),
      ],
    });
    const [p] = await listActiveProjects(home);
    expect(p?.last_active_at).toBe("2026-06-22T09:30:00Z");
  });

  test("a chat with null ended_at falls back to started_at for recency", async () => {
    await seed("aaa", "app", {
      consolidatedAt: "2026-06-01T00:00:00Z",
      chats: [chat({ id: "c1", started_at: "2026-06-18T00:00:00Z", ended_at: null })],
    });
    const [p] = await listActiveProjects(home);
    expect(p?.last_active_at).toBe("2026-06-18T00:00:00Z");
  });

  test("latest_summary = newest chat summary when present", async () => {
    await seed("aaa", "app", {
      consolidatedAt: "2026-06-01T00:00:00Z",
      longTerm: "long term blurb",
      chats: [
        chat({ id: "c1", ended_at: "2026-06-10T00:00:00Z", summary: "older chat" }),
        chat({ id: "c2", ended_at: "2026-06-20T00:00:00Z", summary: "refactor auth middleware" }),
      ],
    });
    const [p] = await listActiveProjects(home);
    expect(p?.latest_summary).toBe("refactor auth middleware");
    expect(p?.chat_count).toBe(2);
  });

  test("latest_summary falls back to long_term_summary when no chat summary", async () => {
    await seed("aaa", "app", {
      consolidatedAt: "2026-06-01T00:00:00Z",
      longTerm: "long term blurb",
      chats: [chat({ id: "c1", ended_at: "2026-06-10T00:00:00Z", summary: "" })],
    });
    const [p] = await listActiveProjects(home);
    expect(p?.latest_summary).toBe("long term blurb");
  });

  test("latest_summary is empty string when neither chat summary nor long_term exists", async () => {
    await seed("aaa", "app", { consolidatedAt: "2026-06-01T00:00:00Z" });
    const [p] = await listActiveProjects(home);
    expect(p?.latest_summary).toBe("");
  });

  test("skips a corrupt project dir without throwing", async () => {
    await seed("good", "good-app", { consolidatedAt: "2026-06-20T00:00:00Z" });
    const badDir = join(home, "projects", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "memory.json"), "not json");
    const list = await listActiveProjects(home);
    expect(list.map((p) => p.display_name)).toEqual(["good-app"]);
  });

  test("ignores stray non-directory entries under projects/", async () => {
    await seed("good", "good-app", { consolidatedAt: "2026-06-20T00:00:00Z" });
    writeFileSync(join(home, "projects", ".DS_Store"), "junk");
    const list = await listActiveProjects(home);
    expect(list).toHaveLength(1);
  });
});
