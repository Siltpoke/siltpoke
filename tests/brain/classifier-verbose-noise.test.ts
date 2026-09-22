// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [12]'s own blast radius: passing `--verbose` made stdout the whole
 * event stream, and `classifyBrainFailure` greps the last 500 bytes of it.
 *
 * Two of the stream's event TYPE NAMES collide with frozen classifier markers:
 * `rate_limit_event` matches `/rate[ _-]?limit/i`. Misclassifying an ambiguous
 * failure as `throttle` authorizes a second PAID spawn (brain-guarded's retry
 * policy), so this is spend, not cosmetics.
 *
 * The markers stay frozen. What changed is the TEXT fed to them.
 */
import { test, expect } from "bun:test";
import { runBrainCall, type BrainError } from "../../src/brain/brain";
import { classifyBrainFailure } from "../../src/brain/failure-classify";

/**
 * Drive the REAL production path: a failing `claude -p` whose stdout is the
 * verbose stream. Asserting through `runBrainCall` rather than exporting the
 * helper keeps the wiring under test — an exported helper with a green test
 * and no production caller is the shape that lets a fix ship unconnected.
 */
async function failureStdoutSeenByClassifier(stdout: string): Promise<string> {
  const spawnFn = ((_cmd: string[], _o: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    exited: Promise.resolve(1),
    kill() {},
  })) as unknown as typeof Bun.spawn;
  const err = (await runBrainCall({
    systemPrompt: "p",
    contextBundle: "c",
    spawnFn,
  }).then(
    () => null,
    (e) => e as BrainError,
  )) as BrainError;
  return err.failure?.stdout ?? "";
}

/** A verbose stream whose noise carries a marker substring, result does not. */
const noisyStream = JSON.stringify([
  { type: "system", subtype: "init" },
  { type: "rate_limit_event", rate_limit: { status: "allowed" } },
  {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    error: "something generic",
  },
]);

test("[12] verbose stream noise no longer flips ambiguous -> throttle", async () => {
  // Device check: the RAW tail really does misclassify. Without this line the
  // test below could pass because the input was harmless all along.
  expect(
    classifyBrainFailure({ exitCode: 1, stderr: "", stdout: noisyStream.slice(-500) }),
  ).toBe("throttle");

  expect(
    classifyBrainFailure({ exitCode: 1, stderr: "", stdout: await failureStdoutSeenByClassifier(noisyStream) }),
  ).toBe("ambiguous");
});

test("[12] a REAL throttle in the result event still classifies as throttle", async () => {
  const realThrottle = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", is_error: true, error: "429 rate_limit_error: too many requests" },
  ]);
  expect(
    classifyBrainFailure({ exitCode: 1, stderr: "", stdout: await failureStdoutSeenByClassifier(realThrottle) }),
  ).toBe("throttle");
});

test("[12] a REAL permanent auth failure in the result event still latches", async () => {
  const auth = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", is_error: true, error: "Invalid API key · Please run /login" },
  ]);
  expect(
    classifyBrainFailure({ exitCode: 1, stderr: "", stdout: await failureStdoutSeenByClassifier(auth) }),
  ).toBe("permanent");
});

test("[12] unparseable stdout falls back to the raw tail (pre-fix behaviour kept)", async () => {
  const plain = "Invalid API key · Please run /login";
  expect(await failureStdoutSeenByClassifier(plain)).toBe(plain);
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "",
      stdout: await failureStdoutSeenByClassifier(plain),
    }),
  ).toBe("permanent");
});

test("[12] the bare single-object envelope is read too, not just the array", async () => {
  const bare = JSON.stringify({
    type: "result",
    is_error: true,
    error: "Invalid API key",
  });
  expect(classifyBrainFailure({ exitCode: 1, stderr: "", stdout: await failureStdoutSeenByClassifier(bare) })).toBe(
    "permanent",
  );
});

test("[12] stderr is untouched — it never carried stream noise", async () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "posix_spawn: EAGAIN",
      stdout: await failureStdoutSeenByClassifier(noisyStream),
    }),
  ).toBe("resource");
});
