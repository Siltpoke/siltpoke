// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Track #9 (Codex T3): de-dupe the legacy ~/.codex/hooks.json entry once the
// plugin-carried hooks.json is live. NOTE — the marker-based dedupe gate
// (src/daemon/marker.ts, src/hooks/on-stop.ts, shipped in Task 7) already
// prevents a DOUBLE REVIEW when both the legacy source hook and the plugin
// hook fire for the same turn: it keys on session_id + a hash of the
// transcript content, which both firing processes compute identically
// regardless of which hooks.json entry invoked them. So `removeCodexLegacyHooks`
// below is a TIDINESS fix (clean `~/.codex/hooks.json` / `codex plugin list`
// output), not a correctness fix for double-spend.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCodexIntegration,
  removeCodexLegacyHooks,
} from "../../src/installer/codex-integration";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-codex-integration-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("removeCodexLegacyHooks", () => {
  test("strips siltpoke source entries, leaves others intact", async () => {
    const env = { HOME: tmpHome };
    const hooksPath = join(tmpHome, ".codex", "hooks.json");

    // Seed via the real installer so the entries are byte-identical to what
    // a pre-plugin `bun run setup --agent codex` install actually wrote.
    await installCodexIntegration("/repo/siltpoke", env);

    // Add a foreign (non-siltpoke) entry to both events to prove the remover
    // doesn't nuke hooks.json wholesale.
    const before = JSON.parse(readFileSync(hooksPath, "utf8"));
    before.hooks.Stop[0].hooks.push({
      type: "command",
      command: "bun /some/other/tool/on-stop.ts",
      timeout: 10,
    });
    before.hooks.SessionStart[0].hooks.push({
      type: "command",
      command: "bun /some/other/tool/on-start.ts",
      timeout: 10,
    });
    writeFileSync(hooksPath, JSON.stringify(before, null, 2));

    await removeCodexLegacyHooks(hooksPath);

    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    const afterStr = JSON.stringify(after);
    expect(afterStr).not.toContain("src/hooks/codex-stop.ts");
    expect(afterStr).not.toContain("src/hooks/handle-session-start.ts");
    expect(afterStr).toContain("/some/other/tool/on-stop.ts");
    expect(afterStr).toContain("/some/other/tool/on-start.ts");
  });

  test("drops the matcher/event entirely when the legacy entry was its only hook (no dangling empty stub)", async () => {
    const env = { HOME: tmpHome };
    const hooksPath = join(tmpHome, ".codex", "hooks.json");

    // Seed via the real installer — Stop/SessionStart each carry exactly one
    // matcher whose only hook is the legacy siltpoke command, no foreign
    // sibling — the case where a naive filter would leave `{ "hooks": [] }`
    // stubs behind instead of fully cleaning up.
    await installCodexIntegration("/repo/siltpoke", env);

    await removeCodexLegacyHooks(hooksPath);

    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(after.hooks.Stop).toBeUndefined();
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  test("no-ops (does not throw, does not create a file) when hooks.json is absent", async () => {
    const hooksPath = join(tmpHome, "does-not-exist", "hooks.json");
    await expect(removeCodexLegacyHooks(hooksPath)).resolves.toBeUndefined();
  });

  test("no-ops fail-soft on malformed JSON", async () => {
    const hooksPath = join(tmpHome, "hooks.json");
    writeFileSync(hooksPath, "{ not valid json");
    await expect(removeCodexLegacyHooks(hooksPath)).resolves.toBeUndefined();
  });
});
