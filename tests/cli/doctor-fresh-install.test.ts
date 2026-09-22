// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Audit defect [2] — a healthy fresh install must not report a failure.
 *
 * Running `/siltpoke-doctor` is the first thing a new user does, and it said
 * "1 of 18 checks failed" on an install where nothing was wrong. The single ✗
 * was `~/.siltpoke/global.json does not exist` — a file `/siltpoke-setup` never
 * writes, created the first time a review awards XP.
 *
 * This is the THIRD instance of one disease: a check that treats "this has not
 * happened yet" as "this is broken". The other two are already fixed and their
 * fixes are visible in the code — `checkInnerTxt` and `checkWakeJson` carry an
 * absent-OK branch, and the slash-command row became an info row under a plugin
 * install after it reported "0/8 broken" on a perfectly healthy one. So the
 * guard here is deliberately NOT "global.json is absent-OK": it is the whole
 * checklist against the state a real fresh install is actually in, because a
 * per-check assertion would not have caught the previous two either.
 *
 * Everything the checklist reads is injected. Nothing here touches the real
 * `$HOME`, so the verdict is about the code, not about this machine.
 *
 * SCOPE, stated rather than implied: this drives `runAllChecks()`, which is the
 * 15 SYNC checks. A real `/siltpoke-doctor` run also reports five async rows —
 * checkProjectResolutionUnderRoot, checkDaemonAlive, checkDaemonStaleness,
 * checkIndexStaleness, checkKnowledgeTracks — and one of them
 * (checkProjectResolutionUnderRoot) can move the exit code. Those are NOT
 * covered here. They were read for the same disease and none of them has it on
 * a fresh install: an empty project list resolves to source "none", which is a
 * warn row, and the daemon rows only hard-fail when the user turned the daemon
 * on and it is actually down. So "no ✗ on a fresh install" is proven for the
 * sync half and argued for the async half.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAllChecks } from "../../src/cli/doctor";
import { type DoctorTmp, setupDoctorTmp, teardownDoctorTmp } from "./_doctor-fixtures";

/** Verbatim shape of the repo's own `hooks/hooks.json`, which ships with the plugin. */
const PLUGIN_HOOKS_JSON = {
  hooks: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} is the host's own expansion, verbatim from hooks/hooks.json.
    Stop: [{ hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"' }] }],
    SessionStart: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: same — host expansion, not a JS template.
      { hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"' }] },
    ],
  },
};

describe("doctor — a freshly installed plugin reports nothing broken", () => {
  let env: DoctorTmp;

  beforeEach(() => {
    env = setupDoctorTmp("doctor-fresh-");
    // Exactly what a `/plugin install` + `/siltpoke-setup` leaves behind, and
    // nothing else. In particular NO global.json: src/cli/install.ts never
    // writes one (zero references to the filename), and src/memory/global.ts
    // creates it only when a review awards XP.
    //
    // hooks.Stop[] stays EMPTY in settings.json on purpose — under a plugin
    // install the plugin's own hooks/hooks.json owns the Stop hook. Writing a
    // curl pair here would exercise the source-checkout path instead and say
    // nothing about the install a new user actually has.
    writeFileSync(
      join(env.claudeHome, "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "bun /plugin/dist/siltpoke-card.js" },
      }),
    );
    mkdirSync(join(env.tmp, "plugin", "hooks"), { recursive: true });
    writeFileSync(
      join(env.tmp, "plugin", "hooks", "hooks.json"),
      JSON.stringify(PLUGIN_HOOKS_JSON),
    );
    writeFileSync(
      join(env.siltpokeHome, "config.json"),
      JSON.stringify({ name: "siltpoke", species: "cat", language: "en" }),
    );
  });

  afterEach(() => {
    teardownDoctorTmp(env);
  });

  /** The checklist as a fresh install produces it — every path injected. */
  function freshChecks() {
    return runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: true,
      pluginHooksJsonPath: join(env.tmp, "plugin", "hooks", "hooks.json"),
      // Absent on this temp path, which is the point: an unwired optional
      // integration and an uninstalled autostart are both normal on day one.
      agyHooksJsonPath: join(env.tmp, "no-such-gemini", "hooks.json"),
      autostartPath: join(env.tmp, "no-such-launchagent.plist"),
      reviewerWhichFn: () => "/usr/local/bin/claude",
    });
  }

  test("no sync check reports a hard failure", () => {
    const failed = freshChecks().filter((r) => !r.pass);
    const report = failed.map((r) => `✗ ${r.name} — ${r.detail ?? "(no detail)"}`).join("\n");
    expect(report).toBe("");
  });

  test("the checklist is non-empty and global.json is among the rows it checked", () => {
    // Guards the assertion above against the way it can pass for the wrong
    // reason: an empty list, or a renamed row, filters to zero failures and
    // prints identically to a clean install.
    const rows = freshChecks();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.map((r) => r.name)).toContain("~/.siltpoke/global.json schema v3 current");
  });

  test("a row that is absent-OK still explains itself", () => {
    // An absent-OK branch that returns a bare pass is indistinguishable from a
    // check that stopped looking. Every row that passes WITHOUT being a plain ✓
    // has to say why.
    for (const row of freshChecks().filter((r) => r.status === "info" || r.status === "warn")) {
      expect(row.detail, `${row.name} is an ${row.status} row with no detail`).toBeTruthy();
    }
  });

  test("a genuinely broken fresh install is still caught", () => {
    // The device check: if the assertion above cannot go red, it proves
    // nothing. Corrupt the one file setup really does write.
    writeFileSync(join(env.siltpokeHome, "config.json"), "{ not json");
    const failed = freshChecks().filter((r) => !r.pass);
    expect(failed.map((r) => r.name)).toContain("~/.siltpoke/config.json valid");
  });
});
