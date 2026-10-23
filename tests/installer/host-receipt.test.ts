// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 (spec §2.2–§2.3): the host integrations — codex,
// codebuddy / qoder, agy (hooks.json key + status line, from both the source
// install and the plugin's configure) — record what they wrote in the install
// receipt: pending before the file changes, done after, nothing when the file
// is left alone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyHostAdapter, codebuddyAdapter, type HostWireContext, qoderAdapter } from "../../src/installer/host-adapter";
import { installCodexIntegration } from "../../src/installer/codex-integration";
import { wireAgyStatusline } from "../../src/installer/agy-statusline";
import { readReceipt, recordBefore } from "../../src/installer/receipt";
import { agyStatuslineEntry } from "../../src/installer/receipt-sites";
import { codexHostAdapter } from "../../src/installer/host-adapter";

let home: string;
let env: NodeJS.ProcessEnv;
const CTX: HostWireContext = { repoRoot: "/repo", secret: "s3cr3t" };
const SAVED_KEYS = ["ANTIGRAVITY_HOME", "GEMINI_HOME", "ANTIGRAVITY_HOOKS_HOME", "SILTPOKE_HOME", "CODEX_HOME"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-host-receipt-"));
  env = { HOME: home };
  for (const k of SAVED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const entry = (id: string) => readReceipt(env)?.entries.find((e) => e.id === id);
const agySettings = (): string => join(home, ".gemini", "antigravity-cli", "settings.json");

describe("codex", () => {
  test("installCodexIntegration records hook:codex, done, pointing at hooks.json", async () => {
    await installCodexIntegration("/repo", env);
    expect(entry("hook:codex")).toMatchObject({
      kind: "host-hook",
      target: join(home, ".codex", "hooks.json"),
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "remove-hook-entries", match: "/repo" },
    });
  });

  test("the adapter goes through the same path", async () => {
    await codexHostAdapter.writeHooks(env, CTX);
    expect(entry("hook:codex")).toMatchObject({ state: "done" });
  });
});

describe("codebuddy / qoder", () => {
  test.each([
    ["codebuddy", codebuddyAdapter, ".codebuddy"],
    ["qodercli", qoderAdapter, ".qoder"],
  ] as const)("%s records hook:<id>, done, pointing at its settings.json", async (id, adapter, dir) => {
    await adapter.writeHooks(env, CTX);
    expect(entry(`hook:${id}`)).toMatchObject({
      kind: "host-hook",
      target: join(home, dir, "settings.json"),
      byUs: true,
      state: "done",
    });
  });

  test("one host does not record another's entry", async () => {
    await codebuddyAdapter.writeHooks(env, CTX);
    expect(entry("hook:qodercli")).toBeUndefined();
    expect(entry("hook:codex")).toBeUndefined();
  });
});

describe("agy — source install (host adapter)", () => {
  test("hooks.json key and the status line are both recorded", async () => {
    await agyHostAdapter.writeHooks(env, CTX);
    expect(entry("hook:antigravity")).toMatchObject({
      kind: "host-hook",
      state: "done",
      undo: { type: "remove-json-key", key: "siltpoke-review" },
    });
    expect(entry("statusline:antigravity")).toMatchObject({
      kind: "statusline",
      target: agySettings(),
      byUs: true,
      state: "done",
    });
  });

  test("the user's own agy status line is kept → hooks recorded, status line NOT", async () => {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(agySettings(), JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }));
    await agyHostAdapter.writeHooks(env, CTX);
    expect(entry("hook:antigravity")).toMatchObject({ state: "done" });
    expect(entry("statusline:antigravity")).toBeUndefined();
  });

  test("a status line entry left pending by an earlier crash is not flipped to done when we keep the user's own", async () => {
    recordBefore(agyStatuslineEntry(agySettings()), env);
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(agySettings(), JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }));
    await agyHostAdapter.writeHooks(env, CTX);
    expect(entry("statusline:antigravity")).toMatchObject({ state: "pending" });
  });

  test("a symlinked settings.json is left untouched → no status-line entry", async () => {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "real.json"), "{}");
    symlinkSync(join(home, "real.json"), agySettings());
    await agyHostAdapter.writeHooks(env, CTX);
    expect(entry("statusline:antigravity")).toBeUndefined();
  });
});

describe("agy — plugin path (wireAgyStatusline)", () => {
  function installAgyPlugin(): void {
    const dist = join(home, ".gemini", "config", "plugins", "siltpoke", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "siltpoke-card.js"), "// card");
  }

  test("wired → statusline:antigravity, done", () => {
    installAgyPlugin();
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("installed");
    expect(entry("statusline:antigravity")).toMatchObject({ kind: "statusline", target: agySettings(), byUs: true, state: "done" });
  });

  test("no agy plugin → nothing recorded", () => {
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("no-agy");
    expect(readReceipt(env)).toBeNull();
  });

  test("someone else's status line (occupied) → nothing recorded", () => {
    installAgyPlugin();
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(agySettings(), JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }));
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("occupied");
    expect(readReceipt(env)).toBeNull();
  });

  test("already wired by an earlier run (no receipt then) → recorded now, done, file untouched", () => {
    installAgyPlugin();
    wireAgyStatusline(env, "/usr/local/bin/bun");
    rmSync(join(home, ".siltpoke"), { recursive: true, force: true }); // an install from before receipts
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("installed");
    expect(entry("statusline:antigravity")).toMatchObject({ state: "done", byUs: true });
  });

  test("a symlinked settings.json → nothing recorded", () => {
    installAgyPlugin();
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "real.json"), "{}");
    symlinkSync(join(home, "real.json"), agySettings());
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("unwritable");
    expect(readReceipt(env)).toBeNull();
  });
});
