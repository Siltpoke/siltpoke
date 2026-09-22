// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [10], second half: doctor never checked the one external condition the
// statusline depends on — that the interpreter in `statusLine.command` can
// actually be run. A Windows user saw a green doctor and no pet.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAllChecks } from "../../src/cli/doctor";
import { type DoctorTmp, setupDoctorTmp, teardownDoctorTmp } from "./_doctor-fixtures";

let env: DoctorTmp;
beforeEach(() => {
  env = setupDoctorTmp("siltpoke-doctor-statusline-");
});
afterEach(() => {
  teardownDoctorTmp(env);
});

function writeSettings(command: string | undefined): void {
  const body = command === undefined ? {} : { statusLine: { type: "command", command } };
  writeFileSync(join(env.claudeHome, "settings.json"), JSON.stringify(body));
}

/** The row, found through the REAL check list — a row nobody registered helps nobody. */
function row(opts: Parameters<typeof runAllChecks>[0] = {}) {
  return runAllChecks({
    claudeHome: env.claudeHome,
    siltpokeHome: env.siltpokeHome,
    ...opts,
  }).find((r) => r.name.toLowerCase().includes("statusline interpreter"));
}

describe("doctor — statusline interpreter row", () => {
  test("the row is registered in runAllChecks", () => {
    writeSettings("sh /home/x/.siltpoke/bin/statusline.sh");
    expect(row({ statuslineWhichFn: () => "/bin/sh" })).toBeDefined();
  });

  test("passes when the interpreter resolves on PATH", () => {
    writeSettings("sh /home/x/.siltpoke/bin/statusline.sh");
    const r = row({ statuslineWhichFn: (c) => (c === "sh" ? "/bin/sh" : null) });
    expect(r?.pass).toBe(true);
  });

  test("FAILS when the interpreter is not resolvable — the Windows bug, made visible", () => {
    writeSettings("sh C:/Users/x/.siltpoke/bin/statusline.sh");
    const r = row({ statuslineWhichFn: () => null });
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain("sh");
    // Actionable, not just red: name the file the user has to edit.
    expect(r?.detail).toContain("statusLine.command");
  });

  test("an absolute interpreter is checked on disk, not on PATH", () => {
    writeSettings('"C:/Program Files/Git/bin/bash.exe" C:/Users/x/.siltpoke/bin/statusline.sh');
    const present = row({
      statuslineExistsFn: (p) => p === "C:/Program Files/Git/bin/bash.exe",
      statuslineWhichFn: () => null, // PATH must not rescue an absolute path
    });
    expect(present?.pass).toBe(true);

    const absent = row({ statuslineExistsFn: () => false, statuslineWhichFn: () => null });
    expect(absent?.pass).toBe(false);
    expect(absent?.detail).toContain("bash.exe");
  });

  test("no statusLine at all is healthy — the statusline is opt-in", () => {
    writeSettings(undefined);
    const r = row({ statuslineWhichFn: () => null });
    expect(r?.pass).toBe(true);
    expect(r?.status).toBe("info");
  });

  test("somebody else's statusline is not ours to grade", () => {
    // A user who never asked for --statusline still has starship in there. A red
    // row about their prompt would be a guard that became the new distortion.
    writeSettings("starship prompt");
    const r = row({ statuslineWhichFn: () => null });
    expect(r?.pass).toBe(true);
    expect(r?.status).toBe("info");
  });

  test("a non-Claude host is not graded on a Claude-only file", () => {
    // Same discipline as checkSettingsJson's defect [16] skip.
    const rows = runAllChecks({
      claudeHome: join(env.tmp, "no-claude"),
      siltpokeHome: env.siltpokeHome,
      agyHooksJsonPath: join(env.tmp, "no-agy.json"),
      codexConfigPath: join(env.tmp, "no-codex.toml"),
      statuslineWhichFn: () => null,
    });
    const r = rows.find((x) => x.name.toLowerCase().includes("statusline interpreter"));
    expect(r?.pass).toBe(true);
  });
});
