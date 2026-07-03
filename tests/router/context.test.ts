import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packContext,
  extractChangedFiles,
  extractLatestUserMessage,
} from "../../src/router/context";
import { spawnWithTimeout } from "../../src/critic/spawn";
import { captureGitBaseline } from "../../src/router/git-snapshot";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-ctx-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("returns placeholder text when transcript file missing", async () => {
  const out = await packContext({
    session_id: "s1",
    cwd: "/tmp",
    transcript_path: join(tmp, "missing.jsonl"),
  });
  expect(out.text).toContain("no transcript file");
  expect(out.turns_included).toBe(0);
});

test("extracts assistant text from JSONL transcript", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello back" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "second turn" }] },
    }),
  ].join("\n");
  writeFileSync(p, lines);
  const out = await packContext({
    session_id: "s1",
    cwd: "/tmp",
    transcript_path: p,
  });
  expect(out.text).toContain("hello back");
  expect(out.text).toContain("second turn");
  expect(out.turns_included).toBe(2);
});

test("caps to maxTurns most recent", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `turn ${i}` }] },
    }),
  ).join("\n");
  writeFileSync(p, lines);
  const out = await packContext({
    session_id: "s1",
    cwd: "/tmp",
    transcript_path: p,
    maxTurns: 5,
  });
  expect(out.turns_included).toBe(5);
  expect(out.text).toContain("turn 29");
  expect(out.text).not.toContain("turn 24");
});

test("extractChangedFiles: returns sorted unique paths from Edit/Write tool_use events", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/a/b.ts" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/a/a.py" },
          },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/a/b.ts" }, // dup
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read", // NOT a change tool — must be ignored
            input: { file_path: "/a/c.md" },
          },
        ],
      },
    }),
  ].join("\n");
  writeFileSync(p, lines);
  const files = await extractChangedFiles(p);
  expect(files).toEqual(["/a/a.py", "/a/b.ts"]);
});

test("extractChangedFiles: empty list when transcript missing", async () => {
  const files = await extractChangedFiles(join(tmp, "nope.jsonl"));
  expect(files).toEqual([]);
});

test("extractLatestUserMessage: returns last user text content", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "first" } }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply" }] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "second user message" },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "reply 2" }] },
    }),
  ].join("\n");
  writeFileSync(p, lines);
  const msg = await extractLatestUserMessage(p);
  expect(msg).toBe("second user message");
});

test("extractLatestUserMessage: handles array content with text parts", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "structured user msg" }],
      },
    }),
  ].join("\n");
  writeFileSync(p, lines);
  const msg = await extractLatestUserMessage(p);
  expect(msg).toBe("structured user msg");
});

test("extractLatestUserMessage: returns empty string when no user events", async () => {
  const p = join(tmp, "t.jsonl");
  writeFileSync(
    p,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "only assistant" }] },
    }),
  );
  const msg = await extractLatestUserMessage(p);
  expect(msg).toBe("");
});

test("skips malformed JSON lines without crashing", async () => {
  const p = join(tmp, "t.jsonl");
  const lines = [
    "{not json",
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    }),
    "garbage{",
  ].join("\n");
  writeFileSync(p, lines);
  const out = await packContext({
    session_id: "s1",
    cwd: "/tmp",
    transcript_path: p,
  });
  expect(out.turns_included).toBe(1);
  expect(out.text).toContain("ok");
});

// ---------------------------------------------------------------------------
// Bash detection + git-snapshot union tests
// ---------------------------------------------------------------------------

// Helpers for git init in temp dirs (mirrors git-snapshot.test.ts pattern)
async function gitInit(dir: string): Promise<void> {
  await spawnWithTimeout({ argv: ["git", "init"], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({
    argv: ["git", "config", "user.email", "test@test.com"],
    cwd: dir,
    timeoutMs: 5000,
  });
  await spawnWithTimeout({
    argv: ["git", "config", "user.name", "Test User"],
    cwd: dir,
    timeoutMs: 5000,
  });
}

async function gitAddCommit(dir: string, message: string): Promise<void> {
  await spawnWithTimeout({ argv: ["git", "add", "."], cwd: dir, timeoutMs: 5000 });
  await spawnWithTimeout({
    argv: ["git", "commit", "-m", message],
    cwd: dir,
    timeoutMs: 5000,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00",
    } as Record<string, string>,
  });
}

describe("extractChangedFiles — Bash detection", () => {
  test("opts omitted → transcript-only behavior (backward-compat regression)", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    // No opts at all — must behave identically to prior transcript-only behavior
    const files = await extractChangedFiles(p);
    expect(files).toEqual(["/a/b.ts"]);
  });

  test("existing Edit/Write/MultiEdit still detected when opts provided", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "src/b.ts" } },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    // opts with no gitBaseline (undefined) → transcript-only, no git call
    const files = await extractChangedFiles(p, {});
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  test("Bash tool_use with sed -i → file detected", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "sed -i 's/foo/bar/g' src/foo.ts" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    const files = await extractChangedFiles(p);
    expect(files).toContain("src/foo.ts");
  });

  test("Bash tool_use with heredoc redirect → file detected", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "cat > src/x.ts <<EOF\nbody\nEOF" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    const files = await extractChangedFiles(p);
    expect(files).toContain("src/x.ts");
  });

  test("Bash with git apply AND git-baseline shows modified file → union", async () => {
    // Set up a real git repo
    await gitInit(tmp);
    writeFileSync(join(tmp, "y.ts"), "const x = 1;\n");
    writeFileSync(join(tmp, "patch.diff"), "# placeholder diff\n");
    await gitAddCommit(tmp, "initial");

    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();

    // Dirty src/y.ts after baseline
    writeFileSync(join(tmp, "y.ts"), "const x = 2;\n");

    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "git apply patch.diff" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);

    const files = await extractChangedFiles(p, { cwd: tmp, gitBaseline: baseline });
    // patch.diff from whitelist parse
    expect(files).toContain("patch.diff");
    // y.ts from git-snapshot diff
    expect(files).toContain("y.ts");
  });

  test("non-git cwd (gitBaseline: null) → whitelist-only result", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "sed -i 's/a/b/' src/z.ts" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    // gitBaseline: null → non-git session
    const files = await extractChangedFiles(p, { cwd: tmp, gitBaseline: null });
    // sed target detected via whitelist
    expect(files).toContain("src/z.ts");
    // No crash; result is an array
    expect(Array.isArray(files)).toBe(true);
  });

  test("console.error called once with correct message for non-git fallback", async () => {
    const p = join(tmp, "t.jsonl");
    writeFileSync(p, JSON.stringify({ type: "assistant", message: { content: [] } }));

    const spy = spyOn(console, "error");
    try {
      await extractChangedFiles(p, { cwd: tmp, gitBaseline: null });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        "[siltpoke] non-git session, Bash detection via whitelist only",
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("multiple Bash + Edit calls interleaved → all files unioned and deduped", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "sed -i 's/x/y/' src/b.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }, // dup of a.ts
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "mv src/c.ts src/d.ts" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    const files = await extractChangedFiles(p);
    // a.ts appears twice but should be deduped
    expect(files.filter((f) => f === "src/a.ts").length).toBe(1);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    // mv emits src (pos[0]) and dst (pos[last])
    expect(files).toContain("src/c.ts");
    expect(files).toContain("src/d.ts");
  });

  test("Bash with non-modifying command (ls -la) → no false positives", async () => {
    const p = join(tmp, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(p, lines);
    const files = await extractChangedFiles(p);
    expect(files).toEqual([]);
  });

  test("git-baseline + cwd, no Bash or Edit calls → only git-snapshot diff returned", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "tracked.ts"), "const x = 1;\n");
    await gitAddCommit(tmp, "initial");

    const baseline = await captureGitBaseline(tmp);
    expect(baseline).not.toBeNull();

    // Dirty file after baseline
    writeFileSync(join(tmp, "tracked.ts"), "const x = 2;\n");

    const p = join(tmp, "t.jsonl");
    // No tool_use events — only a text turn
    writeFileSync(p, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    }));

    const files = await extractChangedFiles(p, { cwd: tmp, gitBaseline: baseline });
    expect(files).toContain("tracked.ts");
  });
});

describe("extractChangedFiles — pruneMissing (renamed/deleted path drop)", () => {
  test("drops an absolute transcript path that no longer exists on disk", async () => {
    const p = join(tmp, "t.jsonl");
    const gonePath = join(tmp, "repoGraph.ts"); // edited then "renamed away" — never created
    const livePath = join(tmp, "repo-graph.ts");
    writeFileSync(livePath, "export const x = 1;\n");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "assistant", message: { content: [
          { type: "tool_use", name: "Edit", input: { file_path: gonePath } },
          { type: "tool_use", name: "Write", input: { file_path: livePath } },
        ] } }),
      ].join("\n"),
    );
    const files = await extractChangedFiles(p, { cwd: tmp, pruneMissing: true });
    expect(files).toContain(livePath);
    expect(files).not.toContain(gonePath);
  });

  test("keeps missing paths when pruneMissing is off (default)", async () => {
    const p = join(tmp, "t.jsonl");
    const gonePath = join(tmp, "repoGraph.ts");
    writeFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", name: "Edit", input: { file_path: gonePath } },
      ] } }),
    );
    const files = await extractChangedFiles(p, { cwd: tmp });
    expect(files).toContain(gonePath);
  });

  test("relative path with no cwd is kept (unverifiable, never drop on doubt)", async () => {
    const p = join(tmp, "t.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", name: "Edit", input: { file_path: "src/web/client/islands/repoGraph.ts" } },
      ] } }),
    );
    // pruneMissing on but no cwd → relative path cannot be resolved → kept
    const files = await extractChangedFiles(p, { pruneMissing: true });
    expect(files).toContain("src/web/client/islands/repoGraph.ts");
  });
});
