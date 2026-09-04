// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { resolveAgentFlag } from "../../src/installer/agent-menu";

// Argv parse contract (mirrors import.meta.main): extract the token after --agent.
function parseAgentArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--agent");
  return i >= 0 ? argv[i + 1] : undefined;
}

describe("--agent argv parse", () => {
  test("extracts the csv token after --agent", () => {
    expect(parseAgentArg(["bun", "install.ts", "--agent", "agy,codex"])).toBe("agy,codex");
  });
  test("absent when flag not present", () => {
    expect(parseAgentArg(["bun", "install.ts", "--noninteractive"])).toBeUndefined();
  });
  test("resolves parsed token to canonical agents", () => {
    const raw = parseAgentArg(["x", "--agent", "agy"])!;
    expect(resolveAgentFlag(raw)).toEqual({ ok: true, agents: ["antigravity"] });
  });
});
