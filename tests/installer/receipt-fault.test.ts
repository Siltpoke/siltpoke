// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.7 (spec §2.1, AC3 at the receipt level): a real process is
// KILLED (SIGKILL — no handlers, no finally) between `recordBefore` and the
// action, and between the action and `markDone`. Afterwards the receipt must be
// readable, the entry must be `pending`, and nothing may claim `done`. The
// end-to-end half of AC3 ("every entry describes something on disk" after the
// planner's check) needs `buildPlan` and lives in P2.1.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDone, readReceipt, receiptPath, recordBefore } from "../../src/installer/receipt";

const RECEIPT_MODULE = join(import.meta.dir, "../../src/installer/receipt.ts");
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "siltpoke-receipt-fault-"));
  env = { HOME: root };
  mkdirSync(join(root, ".siltpoke"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run `body` in a child bun with the receipt module imported; resolves with how it ended. */
async function runChild(body: string): Promise<{ signal: string | null; code: number | null }> {
  const file = join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    file,
    `import { recordBefore, markDone } from ${JSON.stringify(RECEIPT_MODULE)};
const env = { HOME: ${JSON.stringify(root)} };
const entry = (id: string) => ({ id, kind: "file" as const, target: "/x/" + id, byUs: true, level: "uninstall" as const, undo: { type: "remove-link" } });
${body}
`,
  );
  const proc = Bun.spawn(["bun", file], { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", HOME: root } });
  const code = await proc.exited;
  return { signal: proc.signalCode ?? null, code };
}

describe("a process killed mid-install leaves an honest receipt", () => {
  test("killed after recordBefore, before the action → pending, nothing done", async () => {
    const r = await runChild(`
recordBefore(entry("hook:codex"), env);
process.kill(process.pid, "SIGKILL"); // the action never ran
markDone("hook:codex", env);
`);
    expect(r.signal).toBe("SIGKILL");
    const receipt = readReceipt(env);
    expect(receipt?.entries.map((e) => [e.id, e.state])).toEqual([["hook:codex", "pending"]]);
    expect(receipt?.entries.some((e) => e.state === "done")).toBe(false);
  });

  test("killed after the action, before markDone → still pending (the planner checks the disk), the action's effect is on disk", async () => {
    const effect = join(root, "the-action-ran");
    const r = await runChild(`
import { writeFileSync } from "node:fs";
recordBefore(entry("hook:codex"), env);
writeFileSync(${JSON.stringify(effect)}, "x");
process.kill(process.pid, "SIGKILL");
markDone("hook:codex", env);
`);
    expect(r.signal).toBe("SIGKILL");
    expect(existsSync(effect)).toBe(true);
    expect(readReceipt(env)?.entries).toMatchObject([{ id: "hook:codex", state: "pending" }]);
  });

  test("the entries finished before the kill stay done; only the interrupted one is pending", async () => {
    await runChild(`
recordBefore(entry("a"), env);
recordBefore(entry("b"), env);
markDone("a", env); // finishing one must not complete the sibling that is about to be interrupted
process.kill(process.pid, "SIGKILL");
`);
    expect(readReceipt(env)?.entries.map((e) => [e.id, e.state])).toEqual([
      ["a", "done"],
      ["b", "pending"],
    ]);
  });

  test("a kill at an arbitrary instant inside a burst of writes never leaves an unreadable file or a false done", async () => {
    for (let round = 0; round < 12; round++) {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `import { recordBefore } from ${JSON.stringify(RECEIPT_MODULE)};
const env = { HOME: ${JSON.stringify(root)} };
for (let i = 0; i < 400; i++) recordBefore({ id: "e" + i, kind: "file", target: "x".repeat(4000), byUs: true, level: "uninstall", undo: {} }, env);`,
        ],
        { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", HOME: root } },
      );
      await new Promise((resolve) => setTimeout(resolve, 60 + round * 25));
      proc.kill("SIGKILL");
      await proc.exited;
      // Either nothing was written yet, or what is on disk parses: tmp+rename, never a torn file.
      if (existsSync(receiptPath(env))) {
        const receipt = readReceipt(env);
        expect(receipt).not.toBeNull();
        expect(receipt?.entries.every((e) => e.state === "pending")).toBe(true);
      }
    }
  });

  test("every save replaces the file (tmp + rename) rather than rewriting it in place — the property a kill mid-write relies on", () => {
    const e = { id: "a", kind: "file" as const, target: "/x", byUs: true, level: "uninstall" as const, undo: {} };
    recordBefore(e, env);
    // A hard link pins the OLD file: an in-place rewrite changes what the link reads,
    // a tmp + rename leaves it exactly as it was. (Deterministic; inode numbers can be reused.)
    const pinned = join(root, "pinned-old-receipt");
    linkSync(receiptPath(env), pinned);
    const before = readFileSync(pinned, "utf8");
    markDone("a", env);
    recordBefore({ ...e, id: "b" }, env);
    expect(readFileSync(pinned, "utf8")).toBe(before);
    expect(readFileSync(receiptPath(env), "utf8")).not.toBe(before);
  });
});
