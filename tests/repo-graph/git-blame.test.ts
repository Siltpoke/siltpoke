import { test, expect } from "bun:test";
import { blameLines } from "../../src/repo-graph/git-blame";

const SHA_A = "1111111111111111111111111111111111111111";
const ZERO = "0000000000000000000000000000000000000000";
function fakeGit(porcelain: string, capture?: string[][]) {
  return async (argv: string[], _cwd: string) => { capture?.push(argv); return { exitCode: 0, stdout: porcelain, stderr: "" }; };
}

test("maps a porcelain hunk to a sha with committer date, and uses --porcelain -M -C", async () => {
  const argvSeen: string[][] = [];
  const porcelain = [`${SHA_A} 1 1 1`, "committer-time 1720000000", "committer-tz +0000", "\tconst x = 1;"].join("\n");
  const r = await blameLines({ cwd: "/repo", file: "src/a.ts", startLine: 1, endLine: 1, runGit: fakeGit(porcelain, argvSeen) });
  expect(r).toEqual({ kind: "commits", entries: [{ sha: SHA_A, committerDate: "2024-07-03T09:46:40.000Z" }] });
  // guard against test-gaming: the real flags must be present, else move-detection / porcelain parsing silently changes
  expect(argvSeen[0]).toEqual(["blame", "--porcelain", "-M", "-C", "-L", "1,1", "--", "src/a.ts"]);
});

test("all-zero sha ⇒ uncommitted (never a fabricated commit)", async () => {
  const porcelain = [`${ZERO} 1 1 1`, "committer-time 0", "committer-tz +0000", "\tconst y = 2;"].join("\n");
  expect(await blameLines({ cwd: "/repo", file: "src/a.ts", runGit: fakeGit(porcelain) })).toEqual({ kind: "uncommitted" });
});

test("missing file ⇒ missing (git exit 128)", async () => {
  const runGit = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: no such path 'src/gone.ts' in HEAD" });
  expect(await blameLines({ cwd: "/repo", file: "src/gone.ts", runGit })).toEqual({ kind: "missing" });
});

test("nonempty output that parses to zero entries ⇒ error, NOT silent no-WHY", async () => {
  const runGit = async () => ({ exitCode: 0, stdout: "garbage that matches nothing\n", stderr: "" });
  const r = await blameLines({ cwd: "/repo", file: "src/a.ts", runGit });
  expect(r.kind).toBe("error");
});
