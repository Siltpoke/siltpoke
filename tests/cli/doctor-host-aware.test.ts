// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `doctor` must not audit the wrong machine, and must not hand a user a
 * command their host does not have.
 *
 * WHY — audit defect `[16]`. Under an agy HOME, doctor printed two red rows
 * about `~/.claude/settings.json` and Claude Code's Stop-hook registration and
 * told the reader to run `/siltpoke-setup`. agy has none of those: it is wired
 * through `~/.gemini/config/hooks.json`, and `/siltpoke-setup` is a Claude Code
 * slash command. `skills/siltpoke/SKILL.md` lists `doctor` as available, so agy
 * users really do reach those rows.
 *
 * The "never hand a non-Claude host a `/siltpoke-` command" invariant already
 * existed for the three Stop-hook nudges
 * (`tests/plugin/host-aware-nudge.test.ts`, defect `[8]`) — doctor was outside
 * it. That is the shape this repo files under "a defense that exists in one
 * place, and the sibling paths that dropped it".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDoctorHost,
  formatChecklist,
  runAllChecks,
  setupAdviceFor,
} from "../../src/cli/doctor";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sp-doctor-host-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An agy user: no ~/.claude at all, a real ~/.gemini/config/hooks.json. */
function agyHome(): {
  claudeHome: string;
  siltpokeHome: string;
  agyHooksJsonPath: string;
  codexConfigPath: string;
  autostartPath: string;
} {
  const agyHooks = join(root, "gemini", "config", "hooks.json");
  mkdirSync(join(root, "gemini", "config"), { recursive: true });
  writeFileSync(
    agyHooks,
    JSON.stringify({ "siltpoke-review": { Stop: [{ type: "command", command: "bun /x/agy-stop.ts" }] } }),
  );
  const siltpokeHome = join(root, ".siltpoke");
  mkdirSync(siltpokeHome, { recursive: true });
  return {
    // deliberately absent — an agy user has no Claude Code home
    claudeHome: join(root, "no-claude-home"),
    siltpokeHome,
    agyHooksJsonPath: agyHooks,
    // Pinned so the probe cannot read the real ~/.codex of whoever runs this.
    codexConfigPath: join(root, "no-codex", "config.toml"),
    // Pinned ABSENT for the same reason, and it is load-bearing: the autostart
    // row only prints its setup advice when the boot artifact is missing, so
    // on a machine that HAS one (any dev box that ran setup) this fixture
    // never reached the branch. That is how a `/siltpoke-setup` hint shipped
    // to agy users and was caught by a clean Linux CI runner rather than here
    // (2026-09-22).
    autostartPath: join(root, "no-autostart", "siltpoke.plist"),
  };
}

describe("host detection", () => {
  test("a wired agy install with no ~/.claude is antigravity", () => {
    expect(detectDoctorHost(agyHome())).toBe("antigravity");
  });

  test("a present ~/.claude wins — that user's rows are real", () => {
    const opts = agyHome();
    mkdirSync(opts.claudeHome, { recursive: true });
    expect(detectDoctorHost(opts)).toBe("claude-code");
  });

  test("nothing detected falls back to claude-code, NOT to a skip", () => {
    // The conservative default matters: "Claude Code user who has not run
    // setup yet" must keep its red row and its /siltpoke-setup advice —
    // that row is what defect [2] fixed.
    expect(detectDoctorHost({
      claudeHome: join(root, "nope"),
      agyHooksJsonPath: join(root, "nope.json"),
      codexConfigPath: join(root, "nope.toml"),
    }))
      .toBe("claude-code");
  });
});

describe("advice names a command the host actually has", () => {
  test("each host gets its own wording", () => {
    expect(setupAdviceFor("claude-code")).toContain("/siltpoke-setup");
    expect(setupAdviceFor("codex")).toContain("/skills");
    expect(setupAdviceFor("antigravity")).toContain("set up Siltpoke");
    // the phrase is imperative and carries no trailing purpose — call sites add theirs
    expect(setupAdviceFor("claude-code")).not.toContain("to set Siltpoke up");
  });

  test("no non-Claude host is handed a /siltpoke- command", () => {
    for (const host of ["codex", "antigravity"] as const) {
      expect(setupAdviceFor(host)).not.toContain("/siltpoke-");
    }
  });
});

describe("defect [16]: doctor under an agy HOME", () => {
  test("the two Claude-Code rows are informational, not red", () => {
    const results = runAllChecks(agyHome());
    const settings = results.find((r) => r.name.includes("settings.json valid"));
    const stopHook = results.find((r) => r.name.includes("Stop hook registered"));
    expect(settings?.pass).toBe(true);
    expect(settings?.status).toBe("info");
    expect(stopHook?.pass).toBe(true);
    expect(stopHook?.status).toBe("info");
  });

  test("the rendered checklist hands an agy user no /siltpoke- command at all", () => {
    // The whole rendered surface, not just the two rows — the invariant is
    // about what the user reads, and the agy rows' own advice used to say
    // "agy wiring isn't part of /siltpoke-setup yet", which is both a
    // /siltpoke- string and, since defect [9] shipped, no longer true.
    const opts = agyHome();
    const rendered = formatChecklist(runAllChecks(opts));
    expect(rendered).not.toContain("/siltpoke-");
  });

  test("a Claude Code user with no settings.json still gets the red row and the right command", () => {
    const opts = agyHome();
    mkdirSync(opts.claudeHome, { recursive: true });
    const settings = runAllChecks(opts).find((r) => r.name.includes("settings.json valid"));
    expect(settings?.pass).toBe(false);
    expect(settings?.detail).toContain("/siltpoke-setup");
  });
});
