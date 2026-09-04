// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/cli/install";
import type { WizardIO } from "../../src/installer/wizard";

// The daemon is opt-in: the autostart prompt defaults to "no" — autostart only
// powers the opt-in web surfaces (dashboard/chat), core review never needs it.
// Mirrors the harness already established in tests/cli/install.test.ts.

let tmp: string;
let claudeHome: string;
let repoRoot: string;
let env: NodeJS.ProcessEnv;

function recordingIO(answers: string[]): {
  io: WizardIO;
  transcript: () => string;
} {
  let i = 0;
  const chunks: string[] = [];
  return {
    io: {
      async readLine(): Promise<string> {
        return answers[i++] ?? "";
      },
      write(s: string) {
        chunks.push(s);
      },
    },
    transcript: () => chunks.join(""),
  };
}

function countingAutostartFn(): {
  fn: () => Promise<{ status: "installed"; platform: string }>;
  calls: () => number;
} {
  let n = 0;
  return {
    fn: async () => {
      n++;
      return { status: "installed" as const, platform: "darwin" };
    },
    calls: () => n,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-install-autostart-default-"));
  claudeHome = join(tmp, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({ statusLine: { command: "old" } }),
  );
  env = { HOME: tmp, CI: "true" } as NodeJS.ProcessEnv;

  // Fake plugin layout so symlinkCommands (runs before the autostart step on
  // the fresh-install path) has something to walk.
  repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"),
    "---\ndescription: fake\n---\nbody",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("autostart prompt default", () => {
  test("does NOT install autostart when the user accepts the default (Enter)", async () => {
    const autostart = countingAutostartFn();
    const { io } = recordingIO([
      "1",     // select Claude Code
      "yes",   // proceed with install
      "Mochi", // name
      "cat",   // species
      "zh-CN", // language
      "1",     // personality method: defaults
      "",      // autostart question — Enter = accept default (now "no")
    ]);
    const r = await runInstall({
      env,
      repoRoot,
      noninteractive: false,
      io,
      installAutostartFn: autostart.fn,
    });
    expect(r.status).toBe("installed");
    expect(autostart.calls()).toBe(0);
  });
});
