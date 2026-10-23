// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49], step 1: the TypeScript writer of `<siltpoke home>/last-host`
// (the Windows hook guard and the source installer use it; the Unix hook
// wrappers write the same two lines from hooks/lib/record-host.sh).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILIES } from "../../src/brain/brain-config";
import { familyBinary } from "../../src/brain/registry";
import { HOST_BINARY, hostsSeen, readLastHost, recordInstallHost, recordLastHost } from "../../src/installer/last-host";

let sp: string;
beforeEach(() => {
  sp = mkdtempSync(join(tmpdir(), "siltpoke-last-host-ts-"));
});
afterEach(() => rmSync(sp, { recursive: true, force: true }));

const env = () => ({ SILTPOKE_HOME: sp }) as NodeJS.ProcessEnv;
const read = () => readFileSync(join(sp, "last-host"), "utf8");

describe("recordLastHost", () => {
  test("writes the family and the resolved command path, newline-terminated", () => {
    const ok = recordLastHost(env(), "qoder", (bin) => `/opt/tools/${bin}`);
    expect(ok).toBe(true);
    expect(read()).toBe("qoder\n/opt/tools/qodercli\n");
  });

  test("what it writes, readLastHost reads back", () => {
    recordLastHost(env(), "qoder", (bin) => `/opt/tools/${bin}`);
    expect(readLastHost(sp)).toEqual({ family: "qoder", commandPath: "/opt/tools/qodercli" });
    recordLastHost(env(), "agy", () => null);
    expect(readLastHost(sp)).toEqual({ family: "agy", commandPath: null });
  });

  test("command not found: line 2 empty", () => {
    recordLastHost(env(), "codex", () => null);
    expect(read()).toBe("codex\n\n");
  });

  test.each(["", "antigravity", "Claude", "claude\n", "gpt"])("unknown family %j writes nothing", (family) => {
    expect(recordLastHost(env(), family, () => "/x")).toBe(false);
    expect(existsSync(join(sp, "last-host"))).toBe(false);
  });

  test("an unknown family leaves an existing record alone", () => {
    writeFileSync(join(sp, "last-host"), "agy\n\n");
    recordLastHost(env(), "", () => "/x");
    expect(read()).toBe("agy\n\n");
  });

  test("no home at all: returns false, does not throw", () => {
    expect(recordLastHost({} as NodeJS.ProcessEnv, "claude", () => null)).toBe(false);
  });

  test("a throwing lookup still records the family", () => {
    recordLastHost(env(), "agy", () => {
      throw new Error("which exploded");
    });
    expect(read()).toBe("agy\n\n");
  });
});

describe("readLastHost", () => {
  const write = (text: string) => writeFileSync(join(sp, "last-host"), text);

  test("no file: null", () => {
    expect(readLastHost(sp)).toBeNull();
  });

  test("the shell writer's exact output", () => {
    write("codebuddy\n/Users/x/.local/bin/codebuddy\n");
    expect(readLastHost(sp)).toEqual({ family: "codebuddy", commandPath: "/Users/x/.local/bin/codebuddy" });
  });

  test("CRLF line ends (a file touched on Windows) still read", () => {
    write("codex\r\n\r\n");
    expect(readLastHost(sp)).toEqual({ family: "codex", commandPath: null });
  });

  test.each([
    ["empty file", ""],
    ["a name outside the five", "antigravity\n\n"],
    ["wrong case", "Claude\n\n"],
    ["leading space", " claude\n\n"],
    ["trailing junk", "claude code\n\n"],
  ])("%s: null — a damaged record is no record, never a guess", (_label, text) => {
    write(text);
    expect(readLastHost(sp)).toBeNull();
  });

  test.each(["bin/qodercli", "./qodercli", "qodercli", "~/bin/qodercli"])(
    "a path that is not absolute (%s) is dropped; the family is kept",
    (path) => {
      write(`qoder\n${path}\n`);
      expect(readLastHost(sp)).toEqual({ family: "qoder", commandPath: null });
    },
  );
});

// The source installer (`bun run setup --agent <one>`): no hook has run yet, and
// its hooks carry no host variable, so the install is the only moment that knows.
describe("recordInstallHost", () => {
  const which = () => null;

  test.each([
    ["claude-code", "claude"],
    ["codex", "codex"],
    ["codebuddy", "codebuddy"],
    ["qodercli", "qoder"],
    ["antigravity", "agy"],
  ])("exactly one agent wired (%s) records %s", (agent, family) => {
    expect(recordInstallHost(env(), [agent], which)).toBe(true);
    expect(read().split("\n")[0]).toBe(family);
  });

  test("two agents wired: nothing — the installer does not pick one for the user", () => {
    expect(recordInstallHost(env(), ["claude-code", "codex"], which)).toBe(false);
    expect(existsSync(join(sp, "last-host"))).toBe(false);
  });

  test("none wired: nothing", () => {
    expect(recordInstallHost(env(), [], which)).toBe(false);
    expect(existsSync(join(sp, "last-host"))).toBe(false);
  });

  test("a record a real session already wrote is NOT replaced by a re-install", () => {
    writeFileSync(join(sp, "last-host"), "agy\n/opt/agy\n");
    expect(recordInstallHost(env(), ["codex"], which)).toBe(false);
    expect(read()).toBe("agy\n/opt/agy\n");
  });

  test("an agent id this module does not know: nothing", () => {
    expect(recordInstallHost(env(), ["cursor"], which)).toBe(false);
    expect(existsSync(join(sp, "last-host"))).toBe(false);
  });
});

describe("HOST_BINARY", () => {
  test("covers every family and agrees with the provider registry", () => {
    expect(Object.keys(HOST_BINARY).sort()).toEqual([...FAMILIES].sort());
    for (const family of FAMILIES) {
      // The registry answers null for claude (its provider hard-codes the name).
      expect<string>(HOST_BINARY[family]).toBe(familyBinary(family) ?? "claude");
    }
  });
});

// Spec §12.4 — every agent seen, not only the last one.
describe("hosts-seen", () => {
  const seenDir = () => join(sp, "hosts-seen");

  test("recordLastHost touches hosts-seen/<family>; hostsSeen lists every one, newest first", () => {
    recordLastHost(env(), "codex", () => null);
    utimesSync(join(seenDir(), "codex"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    recordLastHost(env(), "claude", () => null);
    const seen = hostsSeen(sp);
    expect(seen.map((s) => s.family)).toEqual(["claude", "codex"]);
    expect(seen[1]?.seenAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("the first write seeds the agent already in last-host, with last-host's time", () => {
    writeFileSync(join(sp, "last-host"), "qoder\n\n");
    const old = new Date("2026-09-01T10:00:00Z");
    utimesSync(join(sp, "last-host"), old, old);
    recordLastHost(env(), "agy", () => null);
    expect(readdirSync(seenDir()).sort()).toEqual(["agy", "qoder"]);
    expect(statSync(join(seenDir(), "qoder")).mtime.getTime()).toBe(old.getTime());
  });

  test("no hosts-seen folder yet: the agent in last-host, at last-host's time", () => {
    writeFileSync(join(sp, "last-host"), "codebuddy\n\n");
    const old = new Date("2026-09-02T10:00:00Z");
    utimesSync(join(sp, "last-host"), old, old);
    expect(hostsSeen(sp)).toEqual([{ family: "codebuddy", seenAt: old.toISOString() }]);
  });

  test("nothing recorded at all: empty", () => {
    expect(hostsSeen(sp)).toEqual([]);
  });

  test("names that are not one of the five are ignored", () => {
    mkdirSync(seenDir(), { recursive: true });
    for (const name of ["agy", "antigravity", ".DS_Store", "codex.tmp"]) writeFileSync(join(seenDir(), name), "");
    expect(hostsSeen(sp).map((s) => s.family)).toEqual(["agy"]);
  });

  test("an install records last-host but not hosts-seen — an install is not a session", () => {
    recordInstallHost(env(), ["codex"], () => null);
    expect(existsSync(join(sp, "last-host"))).toBe(true);
    expect(existsSync(seenDir())).toBe(false);
  });
});
