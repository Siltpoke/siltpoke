// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.4 (spec §2.3): bootstrap.sh / bootstrap.ps1 run before any
// siltpoke code exists, so they leave a one-line JSON fragment about bun
// (`<siltpoke root>/receipt-bootstrap.json`) and the first TS run merges it into
// the real receipt through `mergeBootstrapFragment`, then removes the file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../../src/cli/bootstrap";
import type { Exec } from "../../src/installer/prereq";
import { ensureBun } from "../../src/installer/prereq";
import { bootstrapFragmentPath, mergeBootstrapFragment, readReceipt, receiptPath, recordBefore } from "../../src/installer/receipt";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-fragment-"));
  env = { HOME: home };
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fragment = (text: string): void => writeFileSync(bootstrapFragmentPath(env), text);
const bunEntry = () => readReceipt(env)?.entries.find((e) => e.id === "tool:bun");

describe("mergeBootstrapFragment", () => {
  test("bun was already on PATH → merged as not ours, done; the fragment file is removed", () => {
    fragment('{"id":"tool:bun","byUs":false,"state":"done"}\n');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ kind: "outside-tool", target: "bun", byUs: false, state: "done", level: "purge" });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });

  test("bun was absent and bootstrap installed it → merged as ours, done", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
  });

  test("the installer never finished → merged as pending (the planner checks the disk)", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"pending"}\n');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ byUs: true, state: "pending" });
  });

  test("a UTF-8 BOM (Windows PowerShell's default) does not defeat the parse", () => {
    fragment('﻿{"id":"tool:bun","byUs":true,"state":"done"}\r\n');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
  });

  test("no fragment → no receipt is created", () => {
    mergeBootstrapFragment(env);
    expect(existsSync(receiptPath(env))).toBe(false);
  });

  test.each([
    ["not JSON", "not json at all"],
    ["an id other than tool:bun", '{"id":"hook:codex","byUs":true,"state":"done"}'],
    ["byUs not a boolean", '{"id":"tool:bun","byUs":"yes","state":"done"}'],
    ["a state that is neither pending nor done", '{"id":"tool:bun","byUs":true,"state":"maybe"}'],
    ["an array", "[1,2]"],
  ])("a fragment with %s is ignored and removed, nothing recorded", (_name, body) => {
    fragment(body);
    mergeBootstrapFragment(env);
    expect(existsSync(receiptPath(env))).toBe(false);
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });

  test("the receipt cannot be written → the note is KEPT for the next run, and nothing throws (review M1)", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    expect(() =>
      mergeBootstrapFragment(env, {
        record: () => {
          throw new Error("disk full");
        },
      }),
    ).not.toThrow();
    expect(existsSync(bootstrapFragmentPath(env))).toBe(true);
    mergeBootstrapFragment(env); // next run, receipt writable again
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });

  test("recordBefore worked but markDone threw last time → the next run completes it from the note (round 2)", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    mergeBootstrapFragment(env, { record: (e, en) => { recordBefore(e, en); throw new Error("died before markDone"); } });
    expect(bunEntry()).toMatchObject({ state: "pending" });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(true); // kept: the merge did not finish
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });

  test("a note that says pending never moves a done entry back, and a pending note leaves a pending entry pending", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}');
    mergeBootstrapFragment(env);
    fragment('{"id":"tool:bun","byUs":true,"state":"pending"}');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ state: "done" });
  });

  test("a pending note leaves an entry that is already pending pending", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"pending"}');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ state: "pending" });
    fragment('{"id":"tool:bun","byUs":true,"state":"pending"}');
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ state: "pending", byUs: true });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });

  test("an entry for bun already in the receipt is never overwritten by a fragment", () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}');
    mergeBootstrapFragment(env);
    fragment('{"id":"tool:bun","byUs":false,"state":"done"}'); // a later run saw bun already there (we put it there)
    mergeBootstrapFragment(env);
    expect(bunEntry()).toMatchObject({ byUs: true });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(false);
  });
});

describe("the fragment reaches the receipt through runBootstrap, and survives ensureBun", () => {
  const presentExec: Exec = (cmd, args) =>
    cmd === "command" || cmd === "where"
      ? { status: ["bun", "git", "claude"].includes(args[args.length - 1] as string) ? 0 : 1, stdout: "" }
      : { status: 0, stdout: "" };
  const io = { readLine: async () => "", write: () => {} };

  test("bootstrap.sh installed bun (fragment says ours) → after the whole run bun is still ours", async () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    await runBootstrap({
      exec: presentExec,
      io,
      claudeHome: join(home, ".claude"),
      env,
      platform: "darwin",
      runInstallFn: async () => {},
      plcExecFn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    // ensureBun saw bun on PATH — which is only there because bootstrap put it there.
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
  });

  test("--check mutates nothing: the fragment stays where it is", async () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    await runBootstrap({ exec: presentExec, io, claudeHome: join(home, ".claude"), env, platform: "darwin", check: true });
    expect(existsSync(bootstrapFragmentPath(env))).toBe(true);
    expect(existsSync(receiptPath(env))).toBe(false);
  });

  test("ensureBun on a second run (bun there because we installed it) keeps byUs true", async () => {
    fragment('{"id":"tool:bun","byUs":true,"state":"done"}\n');
    mergeBootstrapFragment(env);
    await ensureBun(presentExec, io, "darwin", env);
    expect(bunEntry()).toMatchObject({ byUs: true, state: "done" });
    expect(readFileSync(receiptPath(env), "utf8")).toContain('"byUs": true');
  });
});
