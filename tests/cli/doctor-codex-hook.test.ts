// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Windows Run 4 (install audit §110 W2): from the codex copy, doctor said "All
// 24 checks passed. Install healthy." while codex had never started Siltpoke's
// Stop hook. The Stop row was "skipped" under codex, so it could not go red.
// The package on that machine had a codex manifest with no `hooks` key and a
// hooks file with no `commandWindows` — both shapes are fixtures below.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorOptions, formatChecklist, formatJson, runAllChecks } from "../../src/cli/doctor";
import { CODEX_RAN_ROW, CODEX_STOP_ROW } from "../../src/cli/doctor-codex-hook-check";

const REPO = process.cwd();

let home: string;
let root: string;
let opts: DoctorOptions;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-doctor-codex-")));
  root = join(home, ".codex", "plugins", "cache", "siltpoke-local", "siltpoke", "1.3.0");
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".siltpoke"));
  // Today's shipped files: the manifest names ./hooks.json, which has commandWindows.
  cpSync(join(REPO, ".codex-plugin", "plugin.json"), join(root, ".codex-plugin", "plugin.json"));
  cpSync(join(REPO, "hooks.json"), join(root, "hooks.json"));
  opts = {
    claudeHome: join(home, ".claude"),
    siltpokeHome: join(home, ".siltpoke"),
    agyHooksJsonPath: join(home, ".gemini", "config", "hooks.json"),
    codexConfigPath: join(home, ".codex", "config.toml"),
    qoderHome: join(home, ".qoder"),
    codebuddyHome: join(home, ".codebuddy"),
    repoRoot: root,
    platform: "win32",
  };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const rowNamed = (results: ReturnType<typeof runAllChecks>, name: string) => results.filter((r) => r.name === name);
const stopRow = (o: DoctorOptions = opts) => {
  const rows = rowNamed(runAllChecks(o), CODEX_STOP_ROW);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const editManifest = (edit: (m: Record<string, unknown>) => void) => {
  const p = join(root, ".codex-plugin", "plugin.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  edit(m);
  writeFileSync(p, JSON.stringify(m));
};
const editStopHandler = (edit: (h: Record<string, unknown>) => void) => {
  const p = join(root, "hooks.json");
  const f = JSON.parse(readFileSync(p, "utf8"));
  edit(f.hooks.Stop[0].hooks[0]);
  writeFileSync(p, JSON.stringify(f));
};

describe("the Stop row from the codex copy checks the declaration, it does not skip", () => {
  test("today's files on Windows: green, and not the old 'skipped' info row", () => {
    const r = stopRow();
    expect([r.pass, r.status]).toEqual([true, "pass"]);
    expect(runAllChecks(opts).some((x) => x.detail?.includes("its Stop hook lives in"))).toBe(false);
  });

  test("today's files on Linux: green too", () => {
    expect(stopRow({ ...opts, platform: "linux" }).pass).toBe(true);
  });

  test("Run 4's package: the manifest names no hooks file -> red, and says codex reads Claude Code's file", () => {
    editManifest((m) => {
      delete m.hooks;
    });
    const r = stopRow();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('names no "hooks" file');
    expect(r.detail).toContain("Claude Code's file");
  });

  test("no commandWindows on Windows -> red", () => {
    editStopHandler((h) => {
      delete h.commandWindows;
    });
    const r = stopRow();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no Windows command");
  });

  test("control: the same file with no commandWindows on Linux is green", () => {
    editStopHandler((h) => {
      delete h.commandWindows;
    });
    expect(stopRow({ ...opts, platform: "linux" }).pass).toBe(true);
  });

  test("a commandWindows that does not start codex-stop is not accepted", () => {
    editStopHandler((h) => {
      h.commandWindows = String(h.commandWindows).replace("codex-stop", "stop");
    });
    expect(stopRow().pass).toBe(false);
  });

  test("the manifest names a file that is not there -> red", () => {
    editManifest((m) => {
      m.hooks = "./nowhere.json";
    });
    const r = stopRow();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain(join(root, "nowhere.json"));
  });

  test("a hooks file whose Stop entry is Claude Code's, not codex-stop -> red", () => {
    cpSync(join(REPO, "hooks", "hooks.json"), join(root, "hooks.json"));
    // Linux, so the Windows-command check cannot be what turns it red.
    const r = stopRow({ ...opts, platform: "linux" });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("has no Stop entry that runs codex-stop");
  });

  test("a hooks file that is not JSON, or whose Stop is not a list -> red", () => {
    writeFileSync(join(root, "hooks.json"), "{ not json");
    expect(stopRow({ ...opts, platform: "linux" }).pass).toBe(false);
    writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { Stop: { command: "codex-stop" } } }));
    expect(stopRow({ ...opts, platform: "linux" }).pass).toBe(false);
  });

  test("no manifest at all -> red", () => {
    rmSync(join(root, ".codex-plugin"), { recursive: true });
    expect(stopRow().pass).toBe(false);
  });

  test("control: a copy that is not codex's never gets the codex row", () => {
    const elsewhere = join(home, "work", "siltpoke");
    mkdirSync(elsewhere, { recursive: true });
    const results = runAllChecks({ ...opts, repoRoot: elsewhere });
    expect(rowNamed(results, CODEX_STOP_ROW)).toEqual([]);
    expect(rowNamed(results, CODEX_RAN_ROW)).toEqual([]);
  });
});

describe("has a codex hook ever run", () => {
  const ranRow = () => {
    const rows = rowNamed(runAllChecks(opts), CODEX_RAN_ROW);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  test("no record -> warn, and it names /hooks", () => {
    const r = ranRow();
    expect([r.pass, r.status]).toEqual([true, "warn"]);
    expect(r.detail).toContain("/hooks");
  });

  test("hosts-seen/codex present -> green, with its time", () => {
    mkdirSync(join(home, ".siltpoke", "hosts-seen"));
    writeFileSync(join(home, ".siltpoke", "hosts-seen", "codex"), "");
    const r = ranRow();
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/^last at \d{4}-/);
  });

  test("no hosts-seen folder: last-host = codex counts (the hostsSeen fallback)", () => {
    writeFileSync(join(home, ".siltpoke", "last-host"), "codex\n\n");
    expect(ranRow().status).toBe("pass");
  });

  test("no hosts-seen folder: last-host = claude does not", () => {
    writeFileSync(join(home, ".siltpoke", "last-host"), "claude\n\n");
    expect(ranRow().status).toBe("warn");
  });

  test("green says the record does not tell plugin from an older install", () => {
    mkdirSync(join(home, ".siltpoke", "hosts-seen"));
    writeFileSync(join(home, ".siltpoke", "hosts-seen", "codex"), "");
    expect(ranRow().detail).toContain("older ~/.codex/hooks.json");
  });

  test("another agent seen, not codex -> still warn", () => {
    mkdirSync(join(home, ".siltpoke", "hosts-seen"));
    writeFileSync(join(home, ".siltpoke", "hosts-seen", "claude"), "");
    expect(ranRow().status).toBe("warn");
  });
});

describe("the summary line does not call a warned install healthy", () => {
  const ok = { name: "a", pass: true, detail: null };
  test("with a ⚠ row", () => {
    const out = formatChecklist([ok, { name: "b", pass: true, detail: "x", status: "warn" }]);
    expect(out).not.toContain("Install healthy");
    expect(out).toContain("All 2 checks passed, with 1 warning above");
  });
  test("two ⚠ rows: plural", () => {
    const w = { name: "w", pass: true, detail: "x", status: "warn" as const };
    expect(formatChecklist([ok, w, w])).toContain("with 2 warnings above — read them");
  });
  test("--quiet with a ⚠ row names the warning", () => {
    const out = formatChecklist([ok, { name: "b", pass: true, detail: "x", status: "warn" }], { quiet: true });
    expect(out).toBe("siltpoke-doctor: all 2 checks passed, with 1 warning (run without --quiet).\n");
  });
  test("--json carries warn_count", () => {
    const j = JSON.parse(formatJson([ok, { name: "b", pass: true, detail: "x", status: "warn" }]));
    expect([j.all_pass, j.warn_count]).toEqual([true, 1]);
  });
  test("control: no ⚠ row", () => {
    expect(formatChecklist([ok])).toContain("All 1 checks passed. Install healthy.");
    expect(formatChecklist([ok], { quiet: true })).toBe("siltpoke-doctor: all 1 checks passed.\n");
  });
});
