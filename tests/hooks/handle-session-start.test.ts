import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { handleSessionStart } from "../../src/hooks/handle-session-start";

describe("handleSessionStart", () => {
  test("captures git HEAD SHA + writes to {cwd}/.siltpoke/baseline.json", async () => {
    const dir = join(tmpdir(), `siltpoke-ss-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
    await handleSessionStart({ cwd: dir, session_id: "test-session" });
    const baselinePath = join(dir, ".siltpoke", "baseline.json");
    expect(existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(baseline.head_sha).toMatch(/^[a-f0-9]+$/);
    expect(baseline.session_id).toBe("test-session");
    rmSync(dir, { recursive: true });
  });

  test("non-git directory → writes baseline with head_sha=null", async () => {
    const dir = join(tmpdir(), `siltpoke-nogit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await handleSessionStart({ cwd: dir, session_id: "test-2" });
    const baseline = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(baseline.head_sha).toBeNull();
    rmSync(dir, { recursive: true });
  });
});
