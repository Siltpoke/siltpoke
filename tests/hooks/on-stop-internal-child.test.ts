// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [73], source-install half: a source install wires `src/hooks/on-stop.ts`
// directly (no .sh wrapper), so a siltpoke-spawned child session (SILTPOKE_INTERNAL=1)
// reaches this entry. It must write nothing and respawn nothing. And no daemon may
// ever be started carrying the marker.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRespawnDaemon } from "../../src/hooks/on-stop";
import { makeSpawnFake } from "./respawn-fixture";

const ENTRY = join(import.meta.dir, "..", "..", "src", "hooks", "on-stop.ts");

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "on-stop-internal-"));
  const dir = join(home, ".siltpoke");
  mkdirSync(dir, { recursive: true });
  // Daemon enabled + unreachable port: unguarded, the entry WOULD try to respawn.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ daemon: { enabled: true } }));
  return home;
}

async function runEntry(home: string, extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SILTPOKE_")) env[k] = v;
  }
  const proc = Bun.spawn([process.execPath, ENTRY], {
    env: { ...env, HOME: home, SILTPOKE_DAEMON_PORT: "65535", SILTPOKE_DISABLE_RESPAWN: "1", ...extra },
    // No session_id: without the marker this takes the cheap "missing session_id"
    // skip path (a telemetry row) and never reaches a brain call.
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp" })),
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode;
}

describe("on-stop.ts entry under SILTPOKE_INTERNAL=1", () => {
  test("writes no telemetry row (the sandbox ~/.siltpoke keeps only its config.json)", async () => {
    const home = sandboxHome();
    expect(await runEntry(home, { SILTPOKE_INTERNAL: "1" })).toBe(0);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["config.json"]);
  });

  test("control: the same entry without the marker does write a row", async () => {
    const home = sandboxHome();
    await runEntry(home, {});
    expect(existsSync(join(home, ".siltpoke", "brain-calls.jsonl"))).toBe(true);
  });
});

describe("codex-stop.ts entry (Codex source installs wire it directly)", () => {
  const CODEX_ENTRY = join(import.meta.dir, "..", "..", "src", "hooks", "codex-stop.ts");

  async function runCodexEntry(home: string, extra: Record<string, string>) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("SILTPOKE_")) env[k] = v;
    }
    const proc = Bun.spawn([process.execPath, CODEX_ENTRY], {
      env: { ...env, HOME: home, SILTPOKE_DAEMON_PORT: "65535", SILTPOKE_DISABLE_RESPAWN: "1", ...extra },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp" })),
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode;
  }

  test("under SILTPOKE_INTERNAL=1 it writes nothing", async () => {
    const home = sandboxHome();
    expect(await runCodexEntry(home, { SILTPOKE_INTERNAL: "1" })).toBe(0);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["config.json"]);
  });

  test("control: without the marker the same entry does write a row", async () => {
    const home = sandboxHome();
    await runCodexEntry(home, {});
    expect(existsSync(join(home, ".siltpoke", "brain-calls.jsonl"))).toBe(true);
  });
});

describe("maybeRespawnDaemon never hands SILTPOKE_INTERNAL to the daemon", () => {
  test("the spawned daemon's env has the marker stripped but keeps the rest", async () => {
    const home = sandboxHome();
    const fake = makeSpawnFake();
    await maybeRespawnDaemon(
      { HOME: home, SILTPOKE_DAEMON_PORT: "65535", SILTPOKE_INTERNAL: "1", KEEP_ME: "yes" },
      fake.fn,
    );
    expect(fake.calls.length).toBe(1);
    const env = (fake.opts[0] as { env?: NodeJS.ProcessEnv }).env;
    expect(env).toBeDefined();
    expect("SILTPOKE_INTERNAL" in env!).toBe(false);
    expect(env!.KEEP_ME).toBe("yes");
  });
});
