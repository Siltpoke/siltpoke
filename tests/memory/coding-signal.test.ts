import { describe, expect, it } from "bun:test";
import { loadRecentCommits, summarizeCriticEvents } from "../../src/memory/coding-signal";
import { candidateSchema } from "../../src/memory/summarizer";

// git log --pretty=format:%x1e%H%x1f%s%x1f%cI --numstat output:
// record-sep \x1e, field-sep \x1f, then numstat lines "add\tdel\tpath".
const GIT_OUT =
  "\x1eabc123\x1ffeat: add score board\x1f2026-06-28T10:00:00Z\n" +
  "5\t2\tsrc/score/board.yaml\n" +
  "10\t0\tsrc/web/score.tsx\n" +
  "\x1edef456\x1ffix: cache key\x1f2026-06-27T09:00:00Z\n" +
  "3\t1\tsrc/memory/load.ts\n";

describe("loadRecentCommits", () => {
  it("parses git log into CommitSignal[]", async () => {
    const commits = await loadRecentCommits("/repo", new Date("2026-06-01"), {
      runGit: async () => GIT_OUT,
    });
    expect(commits.length).toBe(2);
    expect(commits[0]).toEqual({
      sha: "abc123",
      subject: "feat: add score board",
      files: ["src/score/board.yaml", "src/web/score.tsx"],
      additions: 15,
      deletions: 2,
      date: "2026-06-28T10:00:00Z",
    });
  });

  it("returns [] when git throws (non-repo / error)", async () => {
    const commits = await loadRecentCommits("/repo", new Date(0), {
      runGit: async () => {
        throw new Error("not a git repository");
      },
    });
    expect(commits).toEqual([]);
  });

  it("caps at the requested number", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      `\x1esha${i}\x1fmsg ${i}\x1f2026-06-28T10:00:00Z\n1\t0\tf.ts\n`,
    ).join("");
    const commits = await loadRecentCommits("/repo", new Date(0), {
      cap: 30,
      runGit: async () => many,
    });
    expect(commits.length).toBe(30);
  });

  it("drops a commit whose subject carries a secret", async () => {
    const out = "\x1esha1\x1ffix: set api_key=sk-abcdef0123456789abcdef\x1f2026-06-28T10:00:00Z\n1\t0\tf.ts\n";
    const commits = await loadRecentCommits("/repo", new Date(0), {
      runGit: async () => out,
    });
    expect(commits).toEqual([]);
  });
});

describe("summarizeCriticEvents", () => {
  const since = new Date("2026-06-01");
  it("buckets recent critiques by rubric rule-id", () => {
    const entries = [
      { ts: "2026-06-28T00:00:00Z", body: "god-file at src/a.ts:1 — File is 900 lines" },
      { ts: "2026-06-27T00:00:00Z", body: "long-param-list: 6 positional params" },
      { ts: "2026-06-26T00:00:00Z", body: "god-file at src/b.ts:1" },
    ];
    const s = summarizeCriticEvents(entries, since);
    expect(s.total).toBe(3);
    expect(s.byCategory["god-file"]).toBe(2);
    expect(s.byCategory["long-param-list"]).toBe(1);
  });

  it("excludes critiques older than since", () => {
    const entries = [
      { ts: "2026-05-01T00:00:00Z", body: "god-file at src/a.ts:1" },
    ];
    expect(summarizeCriticEvents(entries, since)).toEqual({ byCategory: {}, total: 0 });
  });

  it("buckets unmatched bodies as other", () => {
    const s = summarizeCriticEvents(
      [{ ts: "2026-06-28T00:00:00Z", body: "some freeform note" }],
      since,
    );
    expect(s.byCategory["other"]).toBe(1);
  });
});

describe("stream enum += 'commit'", () => {
  it("candidate source.stream accepts 'commit'", () => {
    const r = candidateSchema.safeParse({
      action: "add",
      candidate_claim: "the user works primarily in TypeScript strict mode",
      evidence_quote: null,
      suggested_confidence: 0.6,
      supersedes_id: null,
      source: { stream: "commit", session_id: null },
    });
    expect(r.success).toBe(true);
  });
});
