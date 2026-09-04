// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Remaining-hosts track, Task 7: removeAgyLegacyHooks strips the pre-plugin
// `siltpoke-review` top-level key a `agyHostAdapter` source install wrote
// into agy's ~/.gemini/config/hooks.json (writeAgyHooksJson,
// src/installer/host-adapter.ts) — same tidiness shape as
// removeCodexLegacyHooks / removeCcForkLegacyHooks, but for agy's
// name-keyed hooks.json layout (a flat map of named hooks, not a
// matcher-array like Claude/codex). TIDINESS not correctness: the
// marker-based dedupe (src/daemon/marker.ts) already collapses a double-fire
// (legacy source hook + plugin hook both firing for the same Stop event) to
// one Brain call.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgyLegacyHooks } from "../../src/installer/agy-migration";

describe("removeAgyLegacyHooks", () => {
  test("deletes only the siltpoke-review key, preserves every other named hook", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(
      p,
      JSON.stringify({
        "siltpoke-review": {
          Stop: [{ type: "command", command: "bun /repo/src/hooks/agy-stop.ts", timeout: 30 }],
        },
        "other-tool": { Stop: [{ type: "command", command: "x", timeout: 10 }] },
      }),
    );
    await removeAgyLegacyHooks(p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after["siltpoke-review"]).toBeUndefined();
    expect(after["other-tool"]).toBeDefined();
  });

  test("missing hooks.json is a silent no-op", async () => {
    await removeAgyLegacyHooks(join(mkdtempSync(join(tmpdir(), "agy-")), "nope.json"));
    // no throw
    expect(true).toBe(true);
  });

  test("malformed hooks.json is a silent no-op", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(p, "{not valid json");
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe("{not valid json");
  });

  test("no siltpoke-review key present is a silent no-op (does not rewrite the file)", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    const seed = JSON.stringify({ "other-tool": { Stop: [{ type: "command", command: "x" }] } });
    writeFileSync(p, seed);
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe(seed);
  });

  test("valid-but-non-object JSON (null) is a silent no-op", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(p, "null");
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe("null");
  });

  test("valid-but-non-object JSON (string) is a silent no-op", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(p, '"hello"');
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe('"hello"');
  });

  test("valid-but-non-object JSON (number) is a silent no-op", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(p, "42");
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe("42");
  });

  test("valid-but-non-object JSON (array) is a silent no-op", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "agy-")), "hooks.json");
    writeFileSync(p, '["item1","item2"]');
    await removeAgyLegacyHooks(p);
    expect(readFileSync(p, "utf8")).toBe('["item1","item2"]');
  });
});
