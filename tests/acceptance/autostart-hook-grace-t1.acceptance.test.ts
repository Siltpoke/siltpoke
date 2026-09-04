/**
 * autostart-hook-grace-t1.acceptance.test.ts — ACCEPTANCE tests for track #6
 * T1 (hook posture swap), AC6 + AC8.
 *
 *   - AC6: the registered Stop fast-path is a `type:"command"` silent curl —
 *     with the daemon DOWN (dead port), running the EXACT command string that
 *     Claude Code would run exits 0 and prints nothing on stdout or stderr
 *     (so Claude Code has no red ECONNREFUSED to surface).
 *   - AC8: the curl entry still authenticates — the X-Siltpoke-Secret header
 *     is inlined in the command string.
 *
 * REGISTER: the command string is taken from the settings shape that
 * registerStopHookPair actually writes (the installer's public mutation API),
 * then executed verbatim via `sh -c` with a JSON body piped on stdin — the
 * same way Claude Code runs Stop hooks.
 */
import { test, expect } from "bun:test";
import {
  registerStopHookPair,
  type StopHookPair,
} from "../../src/installer/settings-mutator";

// Port 1 is unassigned/never listening on loopback — a deterministic
// "daemon down" (connection refused) without needing a real daemon.
const DEAD_PORT_PAIR: StopHookPair = {
  httpUrl: "http://127.0.0.1:1/hooks/stop",
  command: "bun /abs/path/to/on-stop.ts",
  secret: "acceptance-secret",
};

function registeredCurlCommand(): string {
  const settings = registerStopHookPair({}, DEAD_PORT_PAIR);
  const stop = (
    settings.hooks as { Stop: { hooks: { type: string; command?: string }[] }[] }
  ).Stop;
  const curl = stop
    .flatMap((m) => m.hooks ?? [])
    .find((h) => h.type === "command" && (h.command ?? "").includes("curl"));
  expect(curl).toBeDefined();
  return curl?.command ?? "";
}

test("AC6: stop fast-path curl against a dead port exits 0 with zero stdout/stderr", () => {
  const cmd = registeredCurlCommand();
  const proc = Bun.spawnSync(["sh", "-c", `echo '{}' | ${cmd}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toBe("");
});

test("AC8: the executed command carries the X-Siltpoke-Secret header + target URL", () => {
  const cmd = registeredCurlCommand();
  expect(cmd).toContain("X-Siltpoke-Secret: acceptance-secret");
  expect(cmd).toContain("http://127.0.0.1:1/hooks/stop");
});
