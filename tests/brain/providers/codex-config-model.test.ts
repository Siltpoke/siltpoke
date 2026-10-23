// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// readCodexConfigModel — the model codex's own ~/.codex/config.toml sets. Since
// 2026-10-15 the Change-model window shows it, so a wrong answer is visible.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexConfigModel } from "../../../src/brain/providers/codex";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-codex-config-"));
  mkdirSync(join(home, ".codex"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const config = (text: string) => writeFileSync(join(home, ".codex", "config.toml"), text);

test("the top-level model", () => {
  config('approval_policy = "never"\nmodel = "gpt-5.6-sol"\n');
  expect(readCodexConfigModel(home)).toBe("gpt-5.6-sol");
});

// Review 4, [4]: a profile's model is not the one codex runs by default.
test("a model under a [profiles.*] table is not the top-level one", () => {
  config('approval_policy = "never"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
  expect(readCodexConfigModel(home)).toBeUndefined();
});

test("top-level model before a profile: the top-level one", () => {
  config('model = "gpt-5.6-sol"\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
  expect(readCodexConfigModel(home)).toBe("gpt-5.6-sol");
});

test("no config file: nothing", () => {
  expect(readCodexConfigModel(home)).toBeUndefined();
});
