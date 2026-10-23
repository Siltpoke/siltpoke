// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Every sidebar link must lead to a page the daemon actually serves.
//
// Why this boots a real daemon: `/settings` sat unmounted for two months while
// its screen test stayed green and three documents cited its line numbers as
// "the Settings page" (defect [49], found 2026-10-09). A screen test renders a
// component; it says nothing about whether a user can reach it. The check in
// tests/web/routes/nav.test.ts is a hand-kept list of hrefs that must be absent,
// so it can only know about the routes somebody remembered to add.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHandle, startDaemon, stopDaemon } from "../../src/daemon/server";
import { availableNavSections, resetNavAvailability } from "../../src/web/routes/nav";

let handle: DaemonHandle | null = null;
let dir = "";

afterEach(async () => {
  if (handle) await stopDaemon(handle);
  handle = null;
  resetNavAvailability();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "siltpoke-nav-mounted-"));
  handle = await startDaemon({
    port: 0,
    hostname: "127.0.0.1",
    lockPath: join(dir, "siltpoked.lock"),
    pidPath: join(dir, "siltpoked.pid"),
    markerDir: join(dir, "markers"),
    secret: "test-secret",
    homeBase: dir, // never the real ~/.siltpoke
  });
  return `http://127.0.0.1:${handle.server.port}`;
}

describe("sidebar links are reachable on a running daemon", () => {
  test("every available nav entry answers with a page, not a 404", async () => {
    const base = await boot();
    // After boot: the daemon has set which entries this install has.
    const hrefs = availableNavSections().flatMap((s) => s.entries.map((e) => e.href));
    expect(hrefs).toContain("/"); // not vacuous
    expect(hrefs).toContain("/settings");
    for (const href of hrefs) {
      const res = await fetch(`${base}${href}`, { redirect: "manual" });
      expect({ href, status: res.status }).not.toEqual({ href, status: 404 });
      expect(res.status).toBeLessThan(500);
    }
  });

  test("/settings serves the chat row — the place chat's messages send the user to", async () => {
    const base = await boot();
    const res = await fetch(`${base}/settings`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-role-row="chat"');
    expect(html).toContain("Change model");
    // And the sidebar on that page links to it.
    expect(html).toContain('href="/settings"');
  });
});
