// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFirstRunNudge } from "../../src/hooks/handle-session-start";

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "sp-nudge-"));
  mkdirSync(join(d, ".siltpoke"), { recursive: true });
  return d;
}

describe("codexFirstRunNudge", () => {
  it("emits a valid systemMessage JSON once when codex-host + no config", () => {
    const home = scratch();
    const env = { HOME: home, SILTPOKE_HOST: "codex" } as unknown as NodeJS.ProcessEnv;
    const out = codexFirstRunNudge(env);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(typeof parsed.systemMessage).toBe("string");
    expect(parsed.systemMessage.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".siltpoke", ".codex-nudged"))).toBe(true);
  });

  it("stays silent on the second call (marker gate)", () => {
    const home = scratch();
    const env = { HOME: home, SILTPOKE_HOST: "codex" } as unknown as NodeJS.ProcessEnv;
    expect(codexFirstRunNudge(env)).not.toBeNull();
    expect(codexFirstRunNudge(env)).toBeNull();
  });

  it("stays silent when config.json already exists", () => {
    const home = scratch();
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const env = { HOME: home, SILTPOKE_HOST: "codex" } as unknown as NodeJS.ProcessEnv;
    expect(codexFirstRunNudge(env)).toBeNull();
  });

  it("stays silent when not codex-host (Claude Code path untouched)", () => {
    const home = scratch();
    const env = { HOME: home } as unknown as NodeJS.ProcessEnv;
    expect(codexFirstRunNudge(env)).toBeNull();
  });
});
