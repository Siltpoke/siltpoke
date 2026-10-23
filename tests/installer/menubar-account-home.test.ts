// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [71]: the menu-bar setup acts on the macOS ACCOUNT, whatever HOME says.
// SwiftBar's plugin folder comes from `defaults read` (the account's), SwiftBar
// is restarted with `killall` / `open`, and the login item goes into the
// account's launchd domain. Run with HOME pointing at a sandbox, it overwrote
// the real menu-bar script and re-pointed the real login item at the sandbox —
// twice on the maintainer's machine (2026-10-03 from a test, 2026-10-08 from a
// real install into a temporary home).
//
// Every command here is a recorded fake: nothing in this file can reach the machine.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMenubarCli } from "../../src/cli/menubar";
import { accountHome, otherAccountHome } from "../../src/installer/account-home";
import { runMenubarSetup } from "../../src/installer/menubar-setup";

let sandbox: string;
let execs: string[];
let writes: string[];
let out: string[];

/** `id -P` as macOS prints it: ten colon-separated fields, the home is the ninth. */
const idLine = (home: string) => `me:********:501:20::0:0:Me:${home}:/bin/zsh\n`;

/** A machine with SwiftBar already there, whose account home is `account` (null = `id` cannot say). */
function machine(account: string | null, idOutput?: string) {
  return (cmd: string, args: string[]) => {
    execs.push([cmd, ...args].join(" "));
    if (cmd === "/usr/bin/id") {
      return account === null && idOutput === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: idOutput ?? idLine(account as string) };
    }
    if (cmd === "defaults" && args[0] === "read") return { status: 0, stdout: `${join(sandbox, "swiftbar-plugins")}\n` };
    if (cmd === "which") return { status: 0, stdout: "/opt/homebrew/bin/bun\n" };
    return { status: 0, stdout: "" };
  };
}

const setup = (home: string, exec: ReturnType<typeof machine>) =>
  runMenubarSetup({
    env: { HOME: home },
    io: { readLine: async () => "y", write: (s: string) => out.push(s) },
    platform: "darwin",
    home,
    exec,
    existsSync: () => true,
    readFile: () => null,
    writeFile: (p) => writes.push(p),
    rendererPath: "/x/siltpoke-card.js",
  });

/** Commands that change the account or the machine. */
const changed = () => execs.filter((e) => !e.startsWith("/usr/bin/id"));

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-menubar-account-")));
  execs = [];
  writes = [];
  out = [];
});
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

describe("the menu-bar setup refuses a HOME that is not this account's home (defect [71])", () => {
  test("a sandbox home on a real account: nothing is run, written or recorded, and it says why", async () => {
    const r = await setup(sandbox, machine("/Users/real"));
    expect(r).toEqual({ installed: false, wroteShim: false, reason: "not-account-home" });
    expect(changed()).toEqual([]);
    expect(writes).toEqual([]);
    expect(existsSync(join(sandbox, ".siltpoke", "receipt.json"))).toBe(false);
    const said = out.join("");
    expect(said).toContain(sandbox);
    expect(said).toContain("/Users/real");
    expect(said).toContain("Nothing was changed");
  });

  test("control: the account's own home goes through", async () => {
    const r = await setup(sandbox, machine(sandbox));
    expect(r.installed).toBe(true);
    // The shim, and the login item's plist.
    expect(writes.some((p) => p.endsWith("siltpoke.1m.sh"))).toBe(true);
    expect(changed().some((e) => e === "killall SwiftBar")).toBe(true);
    expect(out.join("")).not.toContain("Nothing was changed");
  });

  test("the same home written with a trailing slash, or reached through a link, is still the account's", async () => {
    expect((await setup(`${sandbox}/`, machine(sandbox))).installed).toBe(true);
    const link = join(sandbox, "link-to-home");
    const realHome = join(sandbox, "home");
    mkdirSync(realHome);
    symlinkSync(realHome, link);
    expect((await setup(link, machine(realHome))).installed).toBe(true);
  });

  test("a folder inside the account's home is not the account's home", async () => {
    const r = await setup(join(sandbox, "inner"), machine(sandbox));
    expect(r.reason).toBe("not-account-home");
    expect(changed()).toEqual([]);
  });

  describe("when the account's home cannot be read, the setup goes on as before (unknown is not a mismatch)", () => {
    const cases: Array<[string, string | undefined]> = [
      ["`id` fails", undefined],
      ["`id` prints nothing", ""],
      ["`id` prints something else", "uid=501(me) gid=20(staff)"],
      ["the home field is not a path", "me:x:501:20::0:0:Me:nope:/bin/zsh"],
    ];
    for (const [name, idOutput] of cases) {
      test(name, async () => {
        const r = await setup(sandbox, machine(null, idOutput));
        expect(r.installed).toBe(true);
      });
    }
  });

  test("on another platform the account is never asked", async () => {
    const r = await runMenubarSetup({ env: { HOME: sandbox }, io: { readLine: async () => "y", write: () => {} }, platform: "linux", home: sandbox, exec: machine("/Users/real") });
    expect(r.reason).toBe("not-darwin");
    expect(execs).toEqual([]);
  });
});

describe("`menubar status` and `menubar remove` under another HOME (review of the [71] fix)", () => {
  // Both read SwiftBar's folder from `defaults` — the account's — and `remove` deletes from it.
  let removed: string[];
  let printed: string;
  const cli = (verb: string, home: string, exec: ReturnType<typeof machine>) =>
    runMenubarCli([verb], {
      home,
      platform: "darwin",
      exec,
      existsSync: () => true,
      rm: (p) => removed.push(p),
      write: (s) => { printed += s; },
    });
  beforeEach(() => {
    removed = [];
    printed = "";
  });

  test("remove: the real menu-bar script is not deleted, and no `defaults` question is asked", async () => {
    expect(await cli("remove", sandbox, machine("/Users/real"))).toBe(0);
    expect(removed).toEqual([]);
    expect(changed()).toEqual([]);
    expect(printed).toContain("nothing was removed");
    expect(printed).toContain("/Users/real");
    expect(printed).not.toContain("✓");
  });

  test("status: it says it cannot tell, instead of answering for another home's menu bar", async () => {
    expect(await cli("status", sandbox, machine("/Users/real"))).toBe(0);
    expect(changed()).toEqual([]);
    expect(printed).toContain("cannot tell");
    expect(printed).not.toContain("installed");
  });

  test("control: under the account's own home both work as before", async () => {
    expect(await cli("remove", sandbox, machine(sandbox))).toBe(0);
    expect(removed.length).toBe(1);
    expect(printed).toContain("✓ menu-bar pet removed.");
    printed = "";
    await cli("status", sandbox, machine(sandbox));
    expect(printed).toContain("menu-bar pet: installed");
  });
});

describe("is this HOME another folder than the account's home", () => {
  const id = (home: string) => () => ({ status: 0, stdout: idLine(home) });

  test("two folders that are both on disk and differ: the account's home is returned", () => {
    const a = join(sandbox, "a");
    const b = join(sandbox, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(otherAccountHome(a, id(b))).toBe(b);
  });

  test("neither on disk: the spelling decides, and a trailing slash is not a difference", () => {
    expect(otherAccountHome("/nowhere/home/", id("/nowhere/home"))).toBeNull();
    expect(otherAccountHome("/nowhere/home", id("/nowhere/home/"))).toBeNull();
    expect(otherAccountHome("/nowhere/other", id("/nowhere/home"))).toBe("/nowhere/home");
  });

  test("the account's home cannot be read: null, whatever HOME is", () => {
    expect(otherAccountHome(sandbox, () => ({ status: 1, stdout: "" }))).toBeNull();
  });
});

describe("the account's home, read from the user database", () => {
  test("the ninth field of `id -P`, without a trailing slash", () => {
    expect(accountHome(() => ({ status: 0, stdout: idLine("/Users/real/") }))).toBe("/Users/real");
  });
  test("a full name with a colon in it does not shift the home out of place", () => {
    expect(accountHome(() => ({ status: 0, stdout: "me:********:501:20::0:0:Me: the second:/Users/real:/bin/zsh\n" }))).toBe("/Users/real");
  });
  test("too few fields is not an answer", () => {
    expect(accountHome(() => ({ status: 0, stdout: "/a:/b:/c\n" }))).toBeNull();
  });
  test("null when it cannot be read", () => {
    expect(accountHome(() => ({ status: 1, stdout: idLine("/Users/real") }))).toBeNull();
    expect(accountHome(() => ({ status: 0, stdout: "" }))).toBeNull();
  });
});
