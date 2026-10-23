// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 (spec §2.3, §5): pulling the local bias-audit model is
// recorded as an outside-tool entry — byUs observed BEFORE the pull (was the
// model already on this machine?), pending until the pull exits cleanly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReceipt } from "../../src/installer/receipt";
import { OLLAMA_MODEL, setupOllamaInteractive } from "../../src/installer/setup-ollama";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-ollama-receipt-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const io = { write: () => {} };
const entry = () => readReceipt(env)?.entries.find((e) => e.id === "tool:ollama-model");

describe("setupOllamaInteractive → receipt", () => {
  test("model absent, pull succeeds → ours, done, outside-tool at purge level", async () => {
    await setupOllamaInteractive({
      io,
      env,
      deps: { checkInstalled: async () => true, hasModel: async () => false, pull: async () => {}, validate: async () => true },
    });
    expect(entry()).toMatchObject({ kind: "outside-tool", target: OLLAMA_MODEL, byUs: true, state: "done", level: "purge" });
  });

  test("model already on the machine → recorded as not ours", async () => {
    await setupOllamaInteractive({
      io,
      env,
      deps: { checkInstalled: async () => true, hasModel: async () => true, pull: async () => {}, validate: async () => true },
    });
    expect(entry()).toMatchObject({ byUs: false, state: "done" });
  });

  test("pull fails → the entry stays pending, never done", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await setupOllamaInteractive({
        io,
        env,
        deps: {
          checkInstalled: async () => true,
          hasModel: async () => false,
          pull: async () => {
            throw new Error("pull exited 1");
          },
        },
      });
    } finally {
      console.warn = warn;
    }
    expect(entry()).toMatchObject({ byUs: true, state: "pending" });
  });

  test("ollama itself not installed → nothing pulled, nothing recorded", async () => {
    await setupOllamaInteractive({ io, env, deps: { checkInstalled: async () => false, hasModel: async () => false } });
    expect(readReceipt(env)).toBeNull();
  });

  test("skip → nothing recorded", async () => {
    await setupOllamaInteractive({ io, env, skip: true });
    expect(readReceipt(env)).toBeNull();
  });

  test("model pulled but validation fails → the pull happened, so it is done", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await setupOllamaInteractive({
        io,
        env,
        deps: { checkInstalled: async () => true, hasModel: async () => false, pull: async () => {}, validate: async () => false },
      });
    } finally {
      console.warn = warn;
    }
    expect(entry()).toMatchObject({ state: "done" });
  });
});
