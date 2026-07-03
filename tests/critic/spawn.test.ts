import { test, expect, describe } from "bun:test";
import { spawnWithTimeout } from "../../src/critic/spawn";

describe("spawnWithTimeout", () => {
  test("happy path: echo hello → exitCode 0, stdout contains 'hello', timedOut false", async () => {
    const result = await spawnWithTimeout({
      argv: ["echo", "hello"],
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  test("timeout: sleep 10 with 200ms timeout → timedOut true, exitCode null", async () => {
    const result = await spawnWithTimeout({
      argv: ["sleep", "10"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("ENOENT: /does/not/exist/binary → returns result without throwing", async () => {
    // Should not throw — returns a result with non-zero exitCode or timedOut false
    const result = await spawnWithTimeout({
      argv: ["/does/not/exist/binary"],
      timeoutMs: 5000,
    });
    // Must not throw; exitCode non-zero or timedOut false
    expect(result.timedOut).toBe(false);
    // ENOENT produces exitCode 1 from our catch
    expect(result.exitCode).not.toBe(0);
  });

  test("non-zero exit: bash -c 'exit 7' → exitCode 7, timedOut false", async () => {
    const result = await spawnWithTimeout({
      argv: ["bash", "-c", "exit 7"],
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("stdin pipe: cat with stdin 'hello' → stdout 'hello'", async () => {
    const result = await spawnWithTimeout({
      argv: ["cat"],
      timeoutMs: 5000,
      stdin: "hello",
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  test("zombie reap: timeout case resolves and returns (no hang)", async () => {
    const start = Date.now();
    const result = await spawnWithTimeout({
      argv: ["sleep", "10"],
      timeoutMs: 150,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // Should complete close to the timeout (within 2s)
    expect(elapsed).toBeLessThan(2000);
  });

  test("stderr is captured", async () => {
    const result = await spawnWithTimeout({
      argv: ["bash", "-c", "echo errout >&2"],
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("errout");
  });

  test("cwd option is honored", async () => {
    const result = await spawnWithTimeout({
      argv: ["pwd"],
      cwd: "/tmp",
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // On macOS /tmp may resolve to /private/tmp
    expect(result.stdout.trim()).toMatch(/^\/(?:private\/)?tmp$/);
  });

  test("env override is honored", async () => {
    const result = await spawnWithTimeout({
      argv: ["bash", "-c", "echo $TEST_VAR_SILTPOKE"],
      env: { ...process.env, TEST_VAR_SILTPOKE: "sentinel-value" } as Record<string, string>,
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("sentinel-value");
  });
});
