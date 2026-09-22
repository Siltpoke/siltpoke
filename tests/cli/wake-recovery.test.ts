// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [11] — one Brain failure latched the breaker permanently and the
 * documented way out did not exist.
 *
 * `brain-health.ts` tells the user (in the statusline card, the dashboard
 * strip and the skip telemetry) to "clear via /siltpoke-wake". There was no
 * such command: `src/cli/wake.ts` existed but was wired into neither
 * `siltpoke-cli` nor `.claude-plugin/commands/`, so a new user whose very
 * first Brain call failed (not logged in, token expired, one network blip)
 * lost review forever and silently.
 *
 * Two halves, both needed:
 *   1. the command is reachable from the plugin;
 *   2. it clears the latch on the spot, rather than only arming a 5-minute
 *      marker that a user who does not hit a Stop hook in time never spends.
 */
import { afterAll, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWakeHuman, runWake } from "../../src/cli/wake";
import { runPluginCli } from "../../src/cli/plugin-cli";
import {
  freshBrainHealth,
  writeBrainHealth,
  readBrainHealth,
  recordFailure,
  isBreakerOpen,
} from "../../src/state/brain-health";

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-wake-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** The exact state the audit captured: first call fails, permanent, latched. */
function latchedHome(): string {
  const home = sandbox();
  const latched = recordFailure(freshBrainHealth(), {
    class: "permanent",
    exit_code: 1,
    stderr_excerpt: "Invalid API key · Please run /login",
    ts: new Date("2026-09-17T03:27:22.624Z").toISOString(),
  });
  writeBrainHealth(home, latched);
  // Positive control: the breaker really is latched before wake touches it.
  expect(isBreakerOpen(readBrainHealth(home), new Date()).open).toBe(true);
  return home;
}

test("[11] wake clears a latched permanent breaker immediately", async () => {
  const home = latchedHome();
  const result = await runWake({ homeBase: home });

  expect(result.breaker_cleared).toBe(true);
  expect(result.breaker_class).toBe("permanent");
  const after = readBrainHealth(home);
  expect(after.breaker).toBeNull();
  expect(isBreakerOpen(after, new Date()).open).toBe(false);
  // "Try now", not "declare healthy" — the failure count must survive so the
  // next failure reopens at the escalated window.
  expect(after.consecutive_failures).toBe(1);
  expect(after.last_failure).not.toBeNull();
});

test("[11] wake still writes the one-shot marker (the gate bypass is unchanged)", async () => {
  const home = latchedHome();
  const result = await runWake({ homeBase: home, ttlMs: 60_000 });
  expect(existsSync(result.wake_path)).toBe(true);
  const marker = JSON.parse(readFileSync(result.wake_path, "utf8"));
  expect(marker.schemaVersion).toBe(1);
  expect(marker.expires_at_ms).toBeGreaterThan(Date.now());
});

test("[11] a swallowed write is not reported as a successful clear", async () => {
  // `writeBrainHealth` swallows its errors on purpose ("must never block the
  // critic"). Make the write really fail — read-only directory — and assert
  // the CLI does not claim a clear that did not happen.
  const home = latchedHome();
  // Pre-create wake.json so writing IT still succeeds (directory permissions
  // govern creating files, not writing existing ones), then lock the
  // directory: `atomicWrite` must create a NEW temp file, so only the
  // brain-health write fails.
  writeFileSync(join(home, "wake.json"), "{}", "utf8");
  chmodSync(home, 0o555);
  let result: Awaited<ReturnType<typeof runWake>>;
  try {
    result = await runWake({ homeBase: home });
  } finally {
    chmodSync(home, 0o755);
  }
  // The breaker really is still latched on disk.
  expect(readBrainHealth(home).breaker).not.toBeNull();
  // ...and the user is not told otherwise.
  expect(result.breaker_cleared).toBe(false);
  expect(formatWakeHuman(result)).not.toContain("cleared");
});

test("[11] device check — the same flow DOES clear when the write can succeed", async () => {
  const home = latchedHome();
  const result = await runWake({ homeBase: home });
  expect(result.breaker_cleared).toBe(true);
  expect(readBrainHealth(home).breaker).toBeNull();
});

test("[11] wake on a healthy install is a no-op that says so", async () => {
  const home = sandbox();
  writeBrainHealth(home, freshBrainHealth());
  const result = await runWake({ homeBase: home });
  expect(result.breaker_cleared).toBe(false);
  expect(result.breaker_class).toBeNull();
});

test("[11] `siltpoke-cli wake` is a real subcommand, not `unknown subcommand`", async () => {
  // SILTPOKE_HOME so the handler's own `siltpokeRoot()` lands in the sandbox
  // — an earlier draft of this test wrote a wake marker into the real
  // ~/.siltpoke.
  const home = sandbox();
  writeBrainHealth(
    home,
    recordFailure(freshBrainHealth(), {
      class: "permanent",
      exit_code: 1,
      stderr_excerpt: "Invalid API key",
      ts: new Date().toISOString(),
    }),
  );
  const prev = process.env.SILTPOKE_HOME;
  process.env.SILTPOKE_HOME = home;
  let out = "";
  let err = "";
  try {
    const code = await runPluginCli(["wake"], {
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    });
    expect(err).not.toContain("unknown subcommand");
    expect(code).toBe(0);
  } finally {
    if (prev === undefined) delete process.env.SILTPOKE_HOME;
    else process.env.SILTPOKE_HOME = prev;
  }
  // The whole point of the command, reached through the real dispatch path.
  expect(readBrainHealth(home).breaker).toBeNull();
  // And it says so in words, not as a JSON blob (defect [4] family).
  expect(out).toContain("cleared");
  expect(out).not.toContain('"schemaVersion"');
  expect(existsSync(join(home, "wake.json"))).toBe(true);
});

test("[11] every recovery path brain-health.ts names to the user exists", () => {
  // The strings the user is shown are a promise. [11] was exactly the gap
  // between that promise and the shipped command set.
  // Comments stripped first: a `/siltpoke-review` inside a comment describes
  // a code path, it does not promise the user a command. Only the strings
  // that reach a screen count.
  const src = readFileSync("src/state/brain-health.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const named = [...src.matchAll(/\/siltpoke-([a-z-]+)/g)].map((m) => m[1]!);
  expect(named.length).toBeGreaterThan(0);
  const shipped = readdirSync(".claude-plugin/commands").map((f) =>
    f.replace(/^siltpoke-/, "").replace(/\.md$/, ""),
  );
  const missing = [...new Set(named)].filter((n) => !shipped.includes(n));
  expect(missing).toEqual([]);
});
