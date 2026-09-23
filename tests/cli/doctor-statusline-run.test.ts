// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defects [23] and [24], the two doctor-side halves of the bun-PATH bug.
//
// [23] `✓ statusline interpreter runnable` passed while the statusline rendered
//      nothing: it graded the interpreter and never the condition the shim
//      actually depends on. The new row RUNS the shim — twice, because the
//      interesting question is whether it survives a shell carrying only the
//      system PATH, which is what the host gives its statusline and hooks.
//
// [24] doctor decided "this is a plugin install" from CLAUDE_PLUGIN_ROOT alone.
//      The host sets that for hooks and commands but not for a doctor the user
//      starts by hand, so running it manually on a healthy plugin install read
//      as a from-source checkout and reported two rows red — one of which is
//      the report that opened defect [20] ("hooks.Stop[] is empty").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllChecks } from "../../src/cli/doctor";
import { checkStatuslineRenders } from "../../src/cli/doctor-statusline-run-check";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-doctor-bun-"));
  mkdirSync(join(home, ".siltpoke", "bin"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A statusline shim on disk — the row is an info skip without one. */
function shimExists(): void {
  writeFileSync(join(home, ".siltpoke", "bin", "statusline.sh"), "#!/bin/sh\nexit 0\n");
}

describe("[23] doctor runs the statusline for real", () => {
  test("no shim on disk → info, not a failure (the statusline is opt-in)", () => {
    const r = checkStatuslineRenders({ home, claudeHome: home });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
  });

  test("renders under both PATHs → ✓", () => {
    shimExists();
    const r = checkStatuslineRenders(
      { home, claudeHome: home },
      { runShim: () => "🦠 Silty" },
    );
    expect(r.pass).toBe(true);
    expect(r.status).toBeUndefined();
  });

  test("renders here but NOT on the system PATH alone → warn, and says reviews may not fire", () => {
    shimExists();
    const r = checkStatuslineRenders(
      { home, claudeHome: home },
      {
        // The reporter's machine: bun is on the interactive PATH only.
        runShim: (_shim, path) => (path === "/usr/bin:/bin:/usr/sbin:/sbin" ? "" : "🦠 Silty"),
      },
    );
    expect(r.pass).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("reviews may never fire");
    // Names the mechanism, not just the symptom.
    expect(r.detail).toContain("no PATH-independent route to bun");
  });

  test("the shim's own bun-missing line does NOT count as rendering", () => {
    shimExists();
    const r = checkStatuslineRenders(
      { home, claudeHome: home },
      { runShim: () => "siltpoke: can't find bun (not on PATH) — run /siltpoke-doctor" },
    );
    // Output is non-empty, so a naive "did it print anything" check would have
    // passed here. That is exactly the false green [23] was about.
    expect(r.pass).toBe(false);
  });

  test("renders under neither → ✗", () => {
    shimExists();
    const r = checkStatuslineRenders({ home, claudeHome: home }, { runShim: () => "" });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no pet on either run");
  });

  test("a recorded bun pointer changes the reported route", () => {
    shimExists();
    writeFileSync(join(home, ".siltpoke", "bun-path"), `${process.execPath}\n`);
    const r = checkStatuslineRenders({ home, claudeHome: home }, { runShim: () => "" });
    expect(r.detail).toContain("bun reachable without PATH");
  });
});

/** What the plugin's SessionStart hook writes, and the plugin's own manifest. */
function pluginInstalled(home: string): void {
  const root = join(home, "cache", "siltpoke-1.1.0");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
    join(root, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "sh stop.sh" }] }] },
    }),
  );
  writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
  // A healthy plugin install has an EMPTY settings.json hooks.Stop[].
  writeFileSync(join(home, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
}

/**
 * `repoRoot` is where the code being graded is running FROM. In a real plugin
 * install that is the plugin directory the pointer names — which is the whole
 * discriminator: the pointer must identify THIS install, not just prove that
 * some plugin exists on the machine.
 */
function stopRow(home: string, pluginHooksJsonPath: string, repoRoot?: string) {
  const rows = runAllChecks({
    home,
    claudeHome: home,
    siltpokeHome: join(home, ".siltpoke"),
    pluginHooksJsonPath,
    repoRoot,
  });
  return rows.find((r) => r.name.startsWith("Stop hook registered"))!;
}


describe("[24] plugin install is detected without CLAUDE_PLUGIN_ROOT", () => {
  test("an empty settings.json hooks.Stop[] is reported as plugin-owned, not broken", () => {
    pluginInstalled(home);
    const root = join(home, "cache", "siltpoke-1.1.0");
    const row = stopRow(home, join(root, "hooks", "hooks.json"), root);
    expect(row.pass).toBe(true);
    expect(row.status).toBe("info");
    expect(row.detail).toContain("plugin-owned");
  });

  test("control — no plugin-root pointer → the legacy settings.json check still applies", () => {
    // Same empty hooks.Stop[], no pointer: this IS a real fault for a
    // from-source install, and it must still be reported. Without this control
    // the test above would pass against a row that never fails for anyone.
    writeFileSync(join(home, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    const row = stopRow(home, join(home, "nope", "hooks.json"));
    expect(row.pass).toBe(false);
    expect(row.detail).toContain("missing or empty");
  });

  // Found in review of this very fix: a persistent pointer can outlive the
  // install that wrote it, and it says nothing about what is running NOW.
  //
  // Aimed at the SLASH-COMMAND row on purpose. The Stop-hook row is gated on
  // `isPluginInstall(opts) && pluginOwnsStopHook(opts)`, so a fixture without a
  // readable plugin hooks.json falls through for the second reason no matter
  // what the first one answers — the first version of this test passed with the
  // detection mutated back to its old, broken form. The slash-command row is
  // gated on isPluginInstall ALONE, so it measures only this.
  function slashRow(home: string, repoRoot: string) {
    const rows = runAllChecks({
      home,
      claudeHome: home,
      siltpokeHome: join(home, ".siltpoke"),
      repoRoot,
    });
    return rows.find((r) => r.name.startsWith("slash command"))!;
  }

  test("a pointer naming a DIFFERENT install does not excuse a from-source run", () => {
    pluginInstalled(home); // pointer names <home>/cache/siltpoke-1.1.0 …
    // … but this run happens in a from-source checkout elsewhere, whose
    // .claude-plugin/commands/ does not exist. That is a real fault for a
    // from-source layout and must be reported, not waved through as
    // "shipped with the plugin — no symlinks to verify".
    const elsewhere = join(home, "some", "from-source", "checkout");
    mkdirSync(elsewhere, { recursive: true });
    const row = slashRow(home, elsewhere);
    expect(row.pass).toBe(false);
    expect(row.detail).toContain("does not exist");
  });

  test("control — the pointer naming THIS run's directory is still believed", () => {
    pluginInstalled(home);
    const root = join(home, "cache", "siltpoke-1.1.0");
    const row = slashRow(home, root);
    expect(row.pass).toBe(true);
    expect(row.status).toBe("info");
  });
});
