// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Remaining-hosts track, Task 2: removeCcForkLegacyHooks strips the
// pre-plugin siltpoke Stop/SessionStart entries a ccForkHostAdapter wrote
// into a CC-fork's (qoder/codebuddy) ~/.<host>/settings.json — the same
// tidiness shape as removeCodexLegacyHooks (codex-integration.ts), but for
// the Claude settings.json shape. TIDINESS not correctness: the marker-based
// dedupe (src/daemon/marker.ts) already collapses a double-fire (legacy
// source hook + plugin hook both firing for the same Stop event) to one
// Brain call.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeCcForkLegacyHooks } from "../../src/installer/ccfork-migration";

describe("removeCcForkLegacyHooks", () => {
  test("strips siltpoke source-path Stop hook, keeps foreign hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccfork-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "bun /repo/src/hooks/on-stop.ts" }] },
          { hooks: [{ type: "command", command: "some-other-tool" }] },
        ],
      },
    }));
    await removeCcForkLegacyHooks(p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    const cmds = after.hooks.Stop.flatMap((m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command));
    expect(cmds).toEqual(["some-other-tool"]);
  });

  test("strips the paired legacy curl daemon Stop entry, keeps foreign curl hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccfork-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'curl --silent --max-time 5 -X POST -H "X-Siltpoke-Secret: abc" -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:9876/hooks/stop >/dev/null 2>&1 || true',
              },
              { type: "command", command: "bun /repo/src/hooks/on-stop.ts" },
            ],
          },
          { hooks: [{ type: "command", command: "curl -X POST https://example.com/foreign-webhook" }] },
        ],
      },
    }));
    await removeCcForkLegacyHooks(p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    const cmds = after.hooks.Stop.flatMap((m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command));
    expect(cmds).toEqual(["curl -X POST https://example.com/foreign-webhook"]);
  });

  test("missing settings.json is a silent no-op", async () => {
    await removeCcForkLegacyHooks(join(mkdtempSync(join(tmpdir(), "ccfork-")), "nope.json"));
    // no throw
    expect(true).toBe(true);
  });

  test("a `null` JSON body does not throw and leaves the file untouched", async () => {
    // JSON.parse("null") succeeds (valid JSON) and returns null — `!config.hooks`
    // on that dereferences null, throwing "null is not an object" and violating
    // this function's own fail-soft docstring. Parity with agy-migration.ts's
    // object-shape guard.
    const dir = mkdtempSync(join(tmpdir(), "ccfork-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, "null");
    await expect(removeCcForkLegacyHooks(p)).resolves.toBeUndefined();
    expect(readFileSync(p, "utf8")).toBe("null");
  });

  test("a bare-string JSON body does not throw and leaves the file untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccfork-"));
    const p = join(dir, "settings.json");
    writeFileSync(p, '"just a string"');
    await expect(removeCcForkLegacyHooks(p)).resolves.toBeUndefined();
    expect(readFileSync(p, "utf8")).toBe('"just a string"');
  });
});
