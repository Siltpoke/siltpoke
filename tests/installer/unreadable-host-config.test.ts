// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [85]: when a host's config file could not be read as a JSON object,
// the installer treated it as empty and wrote the whole file back — the user's
// own settings were gone, only Siltpoke's lines were left. Claude Code's side
// already refused (`src/installer/preflight.ts`). The same read was in four
// places: codebuddy's and qoder's settings.json, agy's global hooks.json
// (`src/installer/host-adapter.ts`) and codex's hooks.json
// (`src/installer/codex-integration.ts`, not in the ledger row; found fixing it).
//
// Each case: the install for that host is refused with a message naming the
// file, and the file is byte-for-byte what it was.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installCodexIntegration } from "../../src/installer/codex-integration";
import { codebuddyAdapter, type HostWireContext, qoderAdapter, writeAgyHooksJson } from "../../src/installer/host-adapter";

const CTX: HostWireContext = { repoRoot: "/repo", secret: "s3cr3t" };

/** Two shapes a real file can have that are not a JSON object. */
const UNREADABLE: Array<[string, string]> = [
  ["JSON with a comment (does not parse)", '{\n  // my model\n  "model": "glm-4.6",\n  "permissions": { "allow": ["Bash"] }\n}\n'],
  ["valid JSON that is not an object (an array)", '[{ "model": "glm-4.6" }]\n'],
];

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-unreadable-config-"));
  env = { HOME: home, SILTPOKE_HOME: join(home, ".siltpoke") };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seed(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

const HOSTS: Array<{ name: string; file: () => string; install: () => Promise<unknown> }> = [
  {
    name: "codebuddy settings.json",
    file: () => join(home, ".codebuddy", "settings.json"),
    install: () => codebuddyAdapter.writeHooks(env, CTX),
  },
  {
    name: "qoder settings.json",
    file: () => join(home, ".qoder", "settings.json"),
    install: () => qoderAdapter.writeHooks(env, CTX),
  },
  {
    name: "agy global hooks.json",
    file: () => join(home, ".gemini", "config", "hooks.json"),
    install: () => writeAgyHooksJson(join(home, ".gemini", "config", "hooks.json"), "bun /repo/src/hooks/agy-stop.ts", env),
  },
  {
    name: "codex hooks.json",
    file: () => join(home, ".codex", "hooks.json"),
    install: () => installCodexIntegration("/repo", env),
  },
];

for (const host of HOSTS) {
  describe(`[85] ${host.name}`, () => {
    for (const [shape, body] of UNREADABLE) {
      test(`${shape}: the install is refused, naming the file`, async () => {
        seed(host.file(), body);
        await expect(host.install()).rejects.toThrow(host.file());
      });

      test(`${shape}: the file is left byte-for-byte as it was`, async () => {
        seed(host.file(), body);
        await host.install().catch(() => {});
        expect(readFileSync(host.file(), "utf8")).toBe(body);
      });

      test(`${shape}: no install receipt is started for a file that was not touched`, async () => {
        seed(host.file(), body);
        await host.install().catch(() => {});
        expect(existsSync(join(home, ".siltpoke", "receipt.json"))).toBe(false);
      });
    }

    test("control: a file that is a JSON object keeps the user's keys and gains Siltpoke's", async () => {
      seed(host.file(), '{ "model": "glm-4.6" }\n');
      await host.install();
      const after = JSON.parse(readFileSync(host.file(), "utf8")) as Record<string, unknown>;
      expect(after.model).toBe("glm-4.6");
      expect(Object.keys(after).length).toBeGreaterThan(1);
    });

    test("control: no file yet is still a fresh install, and it starts a receipt", async () => {
      await host.install();
      expect(existsSync(host.file())).toBe(true);
      expect(existsSync(join(home, ".siltpoke", "receipt.json"))).toBe(true);
    });
  });
}

describe("[85] inside a real install run: one refused host does not stop the others", () => {
  test("codebuddy refused with its reason on screen; qoder in the same run is still wired", async () => {
    const { wireSecondaryHosts } = await import("../../src/installer/secondary-hosts");
    const bad = join(home, ".codebuddy", "settings.json");
    seed(bad, UNREADABLE[0][1]);
    const commands = join(home, "repo", ".claude-plugin", "commands");
    mkdirSync(commands, { recursive: true });
    let screen = "";
    const wired = await wireSecondaryHosts({
      env,
      home,
      repoRoot: "/repo",
      selectedAgents: ["codebuddy", "qodercli"],
      pluginCommandsDir: commands,
      platform: process.platform,
      io: { readLine: async () => "", write: (s: string) => { screen += s; } },
    });
    expect(screen).toContain(`⚠ CodeBuddy host wiring failed: ${bad} is not valid JSON`);
    expect(screen).toContain("left it untouched");
    expect(screen).not.toContain("✓ Registered CodeBuddy");
    expect(screen).toContain("✓ Registered Qoder hooks");
    expect(wired).toBe(1);
    expect(readFileSync(bad, "utf8")).toBe(UNREADABLE[0][1]);
  });
});
