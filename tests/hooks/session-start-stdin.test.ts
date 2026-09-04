import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "../../hooks/session-start.sh");

test("session-start.sh forwards the stdin JSON payload to the bundle", async () => {
  // Fake HOME with a config.json so the wrapper's bundle-invoke guard passes.
  const home = mkdtempSync(join(tmpdir(), "sp-home-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "config.json"), "{}");

  // Stub PLUGIN_ROOT whose bundle just writes whatever it reads on stdin.
  const pluginRoot = mkdtempSync(join(tmpdir(), "sp-root-"));
  mkdirSync(join(pluginRoot, "dist"), { recursive: true });
  const stubOut = join(pluginRoot, "stdin-seen.txt");
  writeFileSync(
    join(pluginRoot, "dist", "handle-session-start.js"),
    `await Bun.write(${JSON.stringify(stubOut)}, await Bun.stdin.text());\n`,
  );

  const payload = JSON.stringify({ session_id: "real-uuid-123", cwd: "/tmp/x" });

  const proc = Bun.spawn(["sh", HOOK], {
    stdin: Buffer.from(payload),
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;

  expect(existsSync(stubOut)).toBe(true);
  expect(readFileSync(stubOut, "utf8")).toBe(payload);
});
