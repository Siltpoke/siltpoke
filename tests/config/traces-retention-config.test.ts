// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `traces` config loading — the keys that decide what gets deleted.
 *
 * These are not ordinary settings. On 2026-08-23 the author set
 * `retention_days: 120` to hold a research corpus open, and ~1.4 GB of it was
 * deleted anyway: `max_storage_mb` was absent, defaulted to 500, and the size
 * cap evicted everything past that. The config file looked correct the whole
 * time. So the loader is tested for the failure directions specifically:
 *
 *   - one bad field must not revoke a good one (an object-level `safeParse`
 *     returns `{}` for the whole section, silently reverting BOTH keys to
 *     defaults — and the defaults delete more, not less);
 *   - a rejected value must not be silent, because the degraded direction is
 *     irreversible;
 *   - the bounds must actually be the bounds the docstring claims.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTracesRetentionConfig } from "../../src/config/traces-retention-config";

function homeWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "traces-cfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("loadTracesRetentionConfig", () => {
  test("reads both keys when both are valid", async () => {
    const home = homeWith({ traces: { retention_days: 120, max_storage_mb: 4000 } });
    expect(await loadTracesRetentionConfig(home)).toEqual({
      retention_days: 120,
      max_storage_mb: 4000,
    });
  });

  test("a bad max_storage_mb does NOT revoke a good retention_days", async () => {
    // THE 2026-08-23 SHAPE. `max_storage_mb: 0` is a plausible "no limit"
    // typo. Under an object-level parse the whole section is discarded and
    // retention_days silently drops from 120 to the 30-day default — three
    // months of data deleted by a typo in the OTHER key.
    const home = homeWith({ traces: { retention_days: 120, max_storage_mb: 0 } });
    const cfg = await loadTracesRetentionConfig(home);
    expect(cfg.retention_days).toBe(120);
    expect(cfg.max_storage_mb).toBeUndefined();
  });

  test("a bad retention_days does NOT revoke a good max_storage_mb", async () => {
    const home = homeWith({ traces: { retention_days: "120", max_storage_mb: 4000 } });
    const cfg = await loadTracesRetentionConfig(home);
    expect(cfg.retention_days).toBeUndefined();
    expect(cfg.max_storage_mb).toBe(4000);
  });

  test("rejects out-of-range and non-integer values per key", async () => {
    const cases: Array<[unknown, "retention_days" | "max_storage_mb"]> = [
      [{ retention_days: 0 }, "retention_days"],
      [{ retention_days: 3651 }, "retention_days"],
      [{ retention_days: 120.5 }, "retention_days"],
      [{ max_storage_mb: 0 }, "max_storage_mb"],
      [{ max_storage_mb: 1_000_001 }, "max_storage_mb"],
    ];
    for (const [traces, key] of cases) {
      const cfg = await loadTracesRetentionConfig(homeWith({ traces }));
      expect(cfg[key]).toBeUndefined();
    }
  });

  test("a rejected value is reported, not swallowed", async () => {
    // The degraded direction deletes more data, so silence is the wrong
    // default. Capture what the loader says about a value it threw away.
    const warnings: string[] = [];
    const home = homeWith({ traces: { retention_days: "120", max_storage_mb: 4000 } });
    await loadTracesRetentionConfig(home, { onReject: (m) => warnings.push(m) });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("retention_days");
    // Must not mention the key that was fine.
    expect(warnings[0]).not.toContain("max_storage_mb");
  });

  test("missing file, missing section, and malformed JSON all yield {}", async () => {
    const noFile = mkdtempSync(join(tmpdir(), "traces-cfg-none-"));
    expect(await loadTracesRetentionConfig(noFile)).toEqual({});

    expect(await loadTracesRetentionConfig(homeWith({ name: "Bangbang" }))).toEqual({});

    const broken = mkdtempSync(join(tmpdir(), "traces-cfg-bad-"));
    writeFileSync(join(broken, "config.json"), "{ not json", "utf8");
    expect(await loadTracesRetentionConfig(broken)).toEqual({});
  });

  test("a non-object traces section is rejected without throwing", async () => {
    expect(await loadTracesRetentionConfig(homeWith({ traces: "everything" }))).toEqual({});
    expect(await loadTracesRetentionConfig(homeWith({ traces: 42 }))).toEqual({});
    expect(await loadTracesRetentionConfig(homeWith({ traces: null }))).toEqual({});
  });
});
