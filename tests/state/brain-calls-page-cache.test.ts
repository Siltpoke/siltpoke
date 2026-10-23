/**
 * readBrainCallsPage keeps the parsed log between requests and reads only
 * what was appended since (the live log is 52 MB / 54k lines; a full parse
 * per /timeline request cost ~0.25 s and ~380 MB, measured 2026-10-16).
 *
 * The file is append-only in production, but these tests rewrite, truncate
 * and half-write it, because a stale cache would show turns that are gone or
 * miss turns that are there.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBrainCallsPage } from "../../src/state/critic-event-log";

const page = {
  limit: 50,
  rangeCutoff: null,
  anchor: "newest" as const,
  status: null,
  kind: null,
  query: null,
  project: null,
};

function line(session: string, minute: number, bubble = `turn ${session}`): string {
  return JSON.stringify({
    timestamp: `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`,
    session_id: session,
    cwd: "/Users/foo/projA",
    brain_output: { bubble_short: bubble, bubble_long: null, critique_for_claude: null, severity: "info", confidence: "low", evidence: [] },
  });
}

let base: string;
let file: string;
beforeEach(() => {
  base = join(tmpdir(), `brain-calls-cache-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  file = join(base, "brain-calls.jsonl");
});

const sessions = async () => (await readBrainCallsPage(base, page)).calls.map((c) => c.session_id);

describe("readBrainCallsPage — parsed log kept between requests", () => {
  test("lines appended after a read show up on the next read", async () => {
    writeFileSync(file, `${line("a", 1)}\n${line("b", 2)}\n`);
    expect(await sessions()).toEqual(["a", "b"]);
    appendFileSync(file, `${line("c", 3)}\n`);
    expect(await sessions()).toEqual(["a", "b", "c"]);
    expect((await readBrainCallsPage(base, page)).total).toBe(3);
  });

  test("a file rewritten with different content, same length or longer, is read afresh", async () => {
    writeFileSync(file, `${line("a", 1)}\n${line("b", 2)}\n`);
    expect(await sessions()).toEqual(["a", "b"]);
    // Same byte length, different sessions.
    writeFileSync(file, `${line("x", 1)}\n${line("y", 2)}\n`);
    expect(await sessions()).toEqual(["x", "y"]);
    // Longer, and the old prefix is gone.
    writeFileSync(file, `${line("p", 1)}\n${line("q", 2)}\n${line("r", 3)}\n`);
    expect(await sessions()).toEqual(["p", "q", "r"]);
  });

  test("a truncated file drops the rows that are gone", async () => {
    writeFileSync(file, `${line("a", 1)}\n${line("b", 2)}\n${line("c", 3)}\n`);
    expect(await sessions()).toEqual(["a", "b", "c"]);
    writeFileSync(file, `${line("a", 1)}\n`);
    expect(await sessions()).toEqual(["a"]);
  });

  test("a file replaced by a new one (rename over) is read afresh, even when only its middle differs", async () => {
    // Big enough that the first and last 4 KB do not cover the middle line,
    // so only the inode tells the two files apart.
    const lines = (mid: string) =>
      Array.from({ length: 120 }, (_, i) => line(i === 60 ? mid : `s${String(i).padStart(3, "0")}`, i % 60)).join("\n");
    writeFileSync(file, `${lines("mmm")}\n`);
    const before = (await readBrainCallsPage(base, { ...page, limit: 200 })).calls.map((c) => c.session_id);
    expect(before).toContain("mmm");
    const next = join(base, "next.jsonl");
    writeFileSync(next, `${lines("zzz")}\n`);
    renameSync(next, file);
    const after = (await readBrainCallsPage(base, { ...page, limit: 200 })).calls.map((c) => c.session_id);
    expect(after).toContain("zzz");
    expect(after).not.toContain("mmm");
  });

  test("a half-written last line is not lost once it is finished", async () => {
    const full = line("b", 2);
    writeFileSync(file, `${line("a", 1)}\n${full.slice(0, 20)}`);
    expect(await sessions()).toEqual(["a"]);
    appendFileSync(file, `${full.slice(20)}\n`);
    expect(await sessions()).toEqual(["a", "b"]);
    appendFileSync(file, `${line("c", 3)}\n`);
    expect(await sessions()).toEqual(["a", "b", "c"]);
  });

  test("multi-byte text split across two appends still parses", async () => {
    const full = line("b", 2, "评审 ✓ 完成");
    const bytes = Buffer.from(`${full}\n`, "utf8");
    const cut = Buffer.from(full, "utf8").indexOf(Buffer.from("✓", "utf8")) + 1; // inside the 3-byte ✓
    writeFileSync(file, Buffer.concat([Buffer.from(`${line("a", 1)}\n`, "utf8"), bytes.subarray(0, cut)]));
    expect(await sessions()).toEqual(["a"]);
    appendFileSync(file, bytes.subarray(cut));
    const p = await readBrainCallsPage(base, page);
    expect(p.calls.map((c) => c.bubble_short)).toEqual(["turn a", "评审 ✓ 完成"]);
  });

  test("a last line without a newline is shown, and still shown once more lines follow", async () => {
    writeFileSync(file, `${line("a", 1)}\n${line("b", 2)}`);
    expect(await sessions()).toEqual(["a", "b"]);
    expect(await sessions()).toEqual(["a", "b"]);
    appendFileSync(file, `\n${line("c", 3)}\n`);
    expect(await sessions()).toEqual(["a", "b", "c"]);
  });

  test("CRLF line ends, an empty file, and a row without a readable time", async () => {
    writeFileSync(file, "");
    expect(await sessions()).toEqual([]);
    const noTime = JSON.stringify({ timestamp: "not a time", session_id: "bad", cwd: "/x", brain_output: { bubble_short: "x" } });
    appendFileSync(file, `${line("a", 1)}\r\n${noTime}\r\n${line("b", 2)}\r\n`);
    expect(await sessions()).toEqual(["a", "b"]);
  });

  test("two reads at once share one parse and do not double the rows", async () => {
    writeFileSync(file, `${line("a", 1)}\n${line("b", 2)}\n`);
    const [x, y] = await Promise.all([readBrainCallsPage(base, page), readBrainCallsPage(base, page)]);
    expect(x.calls.map((c) => c.session_id)).toEqual(["a", "b"]);
    expect(y.calls.map((c) => c.session_id)).toEqual(["a", "b"]);
    appendFileSync(file, `${line("c", 3)}\n`);
    const [z] = await Promise.all([readBrainCallsPage(base, page), readBrainCallsPage(base, page)]);
    expect(z.total).toBe(3);
  });

  test("changing a returned row does not change what the next read returns", async () => {
    writeFileSync(file, `${line("a", 1)}\n`);
    const first = await readBrainCallsPage(base, page);
    const row = first.calls[0] as unknown as Record<string, unknown>;
    row.diff_text = "a very large diff";
    row.bubble_short = "edited";
    const again = await readBrainCallsPage(base, page);
    expect(again.calls[0]?.bubble_short).toBe("turn a");
    expect((again.calls[0] as unknown as Record<string, unknown>).diff_text).toBeNull();
  });

  test("two homes keep separate logs", async () => {
    writeFileSync(file, `${line("a", 1)}\n`);
    const other = join(tmpdir(), `brain-calls-cache-${randomUUID()}`);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "brain-calls.jsonl"), `${line("o", 1)}\n`);
    expect(await sessions()).toEqual(["a"]);
    expect((await readBrainCallsPage(other, page)).calls.map((c) => c.session_id)).toEqual(["o"]);
  });

  test("a log that disappears reads as empty", async () => {
    writeFileSync(file, `${line("a", 1)}\n`);
    expect(await sessions()).toEqual(["a"]);
    const { rmSync } = await import("node:fs");
    rmSync(file);
    expect(await sessions()).toEqual([]);
  });
});
