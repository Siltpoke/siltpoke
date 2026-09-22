// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-setup`'s kernel must say what it did.
 *
 * WHY — audit defect `[5d]`
 * (an internal design note). On success the kernel
 * printed nothing at all. The only evidence it had worked was an exit code and
 * the disappearance of the answers file, so the setup command had nothing to
 * relay and the user was told a pet existed on faith.
 *
 * The summary has to report what ACTUALLY happened, not what was asked for:
 * statusline wiring is allowed to fail without taking the pet down, and a
 * summary that reads back the request would then claim a statusline that is
 * not there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigureCli } from "../../src/cli/configure";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-cli-out-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], deps = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runConfigureCli(argv, home, {
    ...noAutostart,
    ...deps,
    out: (s: string) => out.push(s),
    warn: (s: string) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const BASE = ["--name", "Mossbite", "--species", "slime", "--personality", "gentle"];

describe("the setup kernel reports what it did", () => {
  test("success prints the pet, the species and where the config landed", async () => {
    const r = await run(BASE);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Mossbite");
    expect(r.out).toContain("slime");
    expect(r.out).toContain(join(home, ".siltpoke", "config.json"));
  });

  test("success is not silent — the whole point of this defect", async () => {
    const r = await run(BASE);
    expect(r.out.trim().length).toBeGreaterThan(0);
  });

  test("statusline off is reported as off, not omitted", async () => {
    const r = await run(BASE);
    expect(r.out).toMatch(/statusline/i);
  });

  test("statusline on is reported as installed", async () => {
    const r = await run([...BASE, "--statusline"]);
    expect(r.out).toMatch(/statusline/i);
    expect(r.out).not.toMatch(/statusline.*(not|failed)/i);
  });

  test("a statusline that FAILED to wire is not reported as installed", async () => {
    // The pet survives a settings.json failure on purpose (the config is
    // already on disk). The summary must not then claim a statusline the user
    // does not have.
    //
    // `~/.claude` is made a FILE, so `mkdir` inside wireSettings throws EEXIST.
    writeFileSync(join(home, ".claude"), "not a directory");
    const r = await run([...BASE, "--statusline"]);

    // The failure really happened — otherwise the assertions below would pass
    // against an ordinary successful run that simply worded things differently.
    expect(r.err).toMatch(/settings\.json wiring failed/);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);

    expect(r.out).not.toMatch(/statusline installed/i);
    expect(r.out).toMatch(/statusline NOT installed/i);
  });

  test("…and the SAME invocation on a healthy home does say installed (control)", async () => {
    // Same argv, same everything but the broken `~/.claude`. Without this the
    // test above could pass because the summary never mentions statusline.
    const r = await run([...BASE, "--statusline"]);
    expect(r.err).not.toMatch(/settings\.json wiring failed/);
    expect(r.out).toMatch(/statusline installed/i);
  });

  // ── the --daemon path ────────────────────────────────────────────────────
  // The first version of this file never passed `--daemon` at all: the
  // `noAutostart` mock was handed to every call and never once invoked, so the
  // whole autostart branch shipped with zero coverage. A reviewer found the
  // resulting bug on the Windows path below.

  test("autostart installed is reported as installed", async () => {
    const r = await run([...BASE, "--daemon"], {
      installAutostart: async () => ({ status: "installed" as const, platform: "darwin" }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/daemon autostart installed/i);
  });

  test("a platform that DECLINES autostart is not reported as 'off (opt-in)'", async () => {
    // `installAutostartForPlatform` returns status "skipped" on anything that
    // is not darwin or linux — Windows today. That is a different fact from
    // "the user never asked", and saying "off (opt-in)" to someone who DID ask
    // hides the event entirely.
    const r = await run([...BASE, "--daemon"], {
      installAutostart: async () => ({ status: "skipped" as const, platform: "win32" }),
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/opt-in/);
    expect(r.out).toMatch(/daemon autostart NOT installed/i);
    expect(r.out).toMatch(/skipped/);
    expect(r.err).toMatch(/daemon autostart skipped \(platform=win32\)/);
  });

  test("…while NOT asking for the daemon still says 'off (opt-in)' (control)", async () => {
    // Same wording must NOT be reachable from both states — this is the pair
    // that makes the assertion above mean something.
    const r = await run(BASE);
    expect(r.out).toMatch(/opt-in/);
    expect(r.out).not.toMatch(/NOT installed/i);
  });

  test("an autostart that THREW is reported as failed, not as declined", async () => {
    const r = await run([...BASE, "--daemon"], {
      installAutostart: async () => {
        throw new Error("launchctl bootstrap exploded");
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/daemon autostart FAILED/i);
    expect(r.err).toMatch(/launchctl bootstrap exploded/);
  });

  test("a bad species still fails loudly and prints no summary", async () => {
    const r = await run(["--name", "X", "--species", "dragon", "--personality", "gentle"]);
    expect(r.code).not.toBe(0);
    expect(r.out.trim()).toBe("");
    expect(r.err).toMatch(/species/i);
  });

  test("the answers file is deleted on success and kept on failure", async () => {
    const answers = join(home, "answers.json");
    writeFileSync(
      answers,
      JSON.stringify({ name: "Pip", species: "slime", lang: "en", personality: "gentle" }),
    );
    const ok = await run(["--answers-file", answers]);
    expect(ok.code).toBe(0);
    expect(existsSync(answers)).toBe(false);

    const bad = join(home, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({ name: "Pip", species: "dragon", lang: "en", personality: "gentle" }),
    );
    const failed = await run(["--answers-file", bad]);
    expect(failed.code).not.toBe(0);
    expect(existsSync(bad)).toBe(true);
  });
});
