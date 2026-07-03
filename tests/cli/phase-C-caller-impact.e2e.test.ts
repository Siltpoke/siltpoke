import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCallerImpactSection } from "../../src/critic/caller-impact/inject.ts";
import { getRgBin } from "../../src/critic/tools/rg-bin.ts";

// Automated smoke. Exercises the FULL real
// user-facing path end to end with NO Brain call: a real tmp git repo → real
// `git diff` → tree-sitter changed-function extraction → real signature-delta →
// real ripgrep caller resolution → bounded block. This is the live-pipeline
// proof that the grep+sigdelta path actually emits a caller-impact block.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// The real grep resolver needs a genuine ripgrep binary; skip if none resolves
// (CI without Cursor + no RG_BIN_OVERRIDE). Locally CURSOR_RG is present.
function rgAvailable(): boolean {
  try {
    execFileSync(getRgBin(), ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-phaseC-smoke-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(
    join(dir, "src/target.ts"),
    "export function applyDiscount(price: number) {\n  return price * 0.9;\n}\n",
  );
  writeFileSync(
    join(dir, "src/cart.ts"),
    'import { applyDiscount } from "./target.ts";\nexport function total(p: number) {\n  return applyDiscount(p);\n}\n',
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

describe("Caller-impact live pipeline (smoke)", () => {
  const smoke = rgAvailable() ? test : test.skip;

  smoke("a real signature change emits a cross-file caller block", async () => {
    const dir = initRepo();
    try {
      // Add a required param to applyDiscount — the only edit.
      writeFileSync(
        join(dir, "src/target.ts"),
        "export function applyDiscount(price: number, rate: number) {\n  return price * rate;\n}\n",
      );
      const diff = git(dir, ["diff"]);

      const result = await buildCallerImpactSection({
        diffBody: diff,
        changedFiles: ["src/target.ts"],
        cwd: dir,
      });

      // The block names the cross-file caller (cart.ts) — the whole point.
      expect(result.section).toContain("Caller impact");
      expect(result.section).toContain("caller: src/cart.ts:");
      expect(result.tokens.some((t) => t.startsWith("caller: src/cart.ts:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  smoke("a body-only change emits NO block (live)", async () => {
    const dir = initRepo();
    try {
      // Body-only edit — signature unchanged → no caller block.
      writeFileSync(
        join(dir, "src/target.ts"),
        "export function applyDiscount(price: number) {\n  return price * 0.85;\n}\n",
      );
      const diff = git(dir, ["diff"]);
      const result = await buildCallerImpactSection({
        diffBody: diff,
        changedFiles: ["src/target.ts"],
        cwd: dir,
      });
      expect(result.section).toBe("");
      expect(result.tokens).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
