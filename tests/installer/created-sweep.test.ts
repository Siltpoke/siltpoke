// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newlyCreated } from "../../src/installer/created-paths";
import { isEmptyShellFile, sweepCreated } from "../../src/installer/created-sweep";
import { readReceipt, recordBefore, type NewReceiptEntry } from "../../src/installer/receipt";

// `[80]`: the receipt remembers what the install created; the sweep deletes one
// only while it is still empty. Temp homes only — HOME is always passed in.

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-created-")));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { HOME: home };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function hookEntry(target: string, kind: NewReceiptEntry["kind"] = "host-hook"): NewReceiptEntry {
  return { id: `x:${target}`, kind, target, byUs: true, level: "uninstall", undo: { type: "none" } };
}

describe("newlyCreated — what is not there yet", () => {
  test("lists the missing folders above a target, and the target itself for a host file", () => {
    const target = join(home, ".gemini", "config", "hooks.json");
    expect(newlyCreated(target, "host-hook", home)).toEqual([join(home, ".gemini", "config"), join(home, ".gemini"), target]);
  });

  test("a link or command file is not listed itself — only the folders above it", () => {
    const target = join(home, ".qoder", "commands", "a.md");
    expect(newlyCreated(target, "file", home)).toEqual([join(home, ".qoder", "commands"), join(home, ".qoder")]);
  });

  test("things that already exist are not listed", () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "hooks.json"), "{}");
    expect(newlyCreated(join(home, ".codex", "hooks.json"), "host-hook", home)).toEqual([]);
  });

  test("never the home folder or anything outside it", () => {
    expect(newlyCreated(join(root, "elsewhere", "x.json"), "host-hook", home)).toEqual([]);
  });
});

describe("recordBefore remembers what it created", () => {
  test("the receipt lists the new folders and file, and a second record adds nothing twice", () => {
    const target = join(home, ".codex", "hooks.json");
    recordBefore(hookEntry(target), env);
    mkdirSync(join(home, ".codex"));
    writeFileSync(target, "{}\n");
    recordBefore(hookEntry(target), env);
    expect(readReceipt(env)?.created).toEqual([join(home, ".codex"), target]);
  });

  test("an older receipt with no list reads as none, and nothing is swept", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "receipt.json"), JSON.stringify({ version: 1, entries: [], projects: [] }));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "hooks.json"), "{}\n");
    expect(readReceipt(env)?.created).toBeUndefined();
    expect(sweepCreated(env)).toEqual([]);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
  });
});

describe("isEmptyShellFile — what counts as empty", () => {
  test.each([["{}"], ["{}\n"], ["  { }  \n"], [""], ["\n\n"], ["﻿{}"]])("%j is empty", (text) => {
    expect(isEmptyShellFile(text)).toBe(true);
  });
  test.each([['{"a":1}'], ["[]"], ["null"], ['{"hooks":{}}'], ["not json"], ["{} // note"], ["x".repeat(500)]])("%j is not", (text) => {
    expect(isEmptyShellFile(text)).toBe(false);
  });
});

describe("sweepCreated", () => {
  const target = () => join(home, ".gemini", "config", "hooks.json");
  function install(content = "{}\n"): void {
    recordBefore(hookEntry(target()), env);
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(target(), content);
  }

  test("removes the created file and the folders above it, bottom-up, once empty", () => {
    install();
    expect(sweepCreated(env).length).toBe(3);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    expect(existsSync(home)).toBe(true);
    expect(readReceipt(env)?.created).toEqual([]);
  });

  test("keeps a created file that has user content, and the folders above it", () => {
    install('{"mine":true}\n');
    expect(sweepCreated(env)).toEqual([]);
    expect(readFileSync(target(), "utf8")).toBe('{"mine":true}\n');
    expect(readReceipt(env)?.created?.length).toBe(3);
  });

  test("keeps a created folder the user has since put a file in", () => {
    install();
    writeFileSync(join(home, ".gemini", "config", "notes.txt"), "mine");
    sweepCreated(env);
    expect(existsSync(join(home, ".gemini", "config", "notes.txt"))).toBe(true);
    expect(existsSync(target())).toBe(false); // the empty {} file itself was ours and empty
  });

  test("never touches something that was not recorded", () => {
    mkdirSync(join(home, "mine"));
    install();
    sweepCreated(env);
    expect(existsSync(join(home, "mine"))).toBe(true);
  });

  test("does not follow a link: a recorded folder replaced by a link to outside is left", () => {
    install();
    rmSync(join(home, ".gemini"), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(home, ".gemini"));
    expect(sweepCreated(env)).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });

  test("ignores a recorded path outside the home", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    recordBefore(hookEntry(target()), env);
    const path = join(home, ".siltpoke", "receipt.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...receipt, created: [outside, home] }));
    expect(sweepCreated(env)).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(home)).toBe(true);
  });
});
