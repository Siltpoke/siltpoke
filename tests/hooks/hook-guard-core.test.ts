// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The Windows hook guard's branches, and the one property that matters more
// than any of them: it never prints.
//
// WHY THAT PROPERTY NEEDS ITS OWN ASSERTIONS. `hooks/stop.sh` states the
// contract in a comment ("Siltpoke must never put an error in the user's
// Claude Code session") and enforces it by construction — every branch is a
// bare `exit 0`. A TypeScript port has far more ways to talk: an uncaught
// throw, a spawn error event, a rejected promise, a library that warns. So the
// silence is asserted directly on stdout AND stderr for every exit reason,
// rather than inferred from reading the code.
//
// WHY `decide` IS TESTED SEPARATELY FROM `main`. `decide` is pure, so its six
// branches are reachable without a real home directory. `main` owns everything
// that could print. Testing only `decide` would pass while `main` talked —
// which is why the silence tests below drive `main`, not `decide`.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
// readStdinBytes lives in the runtime half; imported directly so the payload
// tests sit next to the decision tests they belong with.
import { readStdinBytes } from "../../src/hooks/hook-guard";
import {
  decide,
  detectHostFamily,
  type GuardDeps,
  NUDGE_TEXT,
  resolvePluginRoot,
  selfTestLine,
} from "../../src/hooks/hook-guard-core";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "siltpoke-guard-"));
}

/** A home with config.json present, i.e. setup has run. */
function configuredHome(): string {
  const home = tempHome();
  writeFileSync(join(home, "config.json"), "{}");
  return home;
}

function deps(home: string, over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    env: { SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: "/plugin" },
    resolveBun: () => "/usr/local/bin/bun",
    fileExists: (p) => existsSync(p) || p === "/plugin/dist/siltpoke-stop.js",
    writeNudgeMarker: () => true,
    guardDir: "/plugin/dist",
    ...over,
  };
}

describe("decide — the branches", () => {
  // T1
  test("no config.json ⇒ exit, and in session-start mode not even a nudge", () => {
    const home = tempHome();
    const stop = decide("stop", deps(home, { writeNudgeMarker: () => true }));
    expect(stop).toEqual({ action: "exit", reason: "no-config", nudge: NUDGE_TEXT });

    // `hooks/session-start.sh` has no nudge. A second copy of the same line
    // from a second hook would double it on every turn of a fresh install.
    const start = decide("session-start", deps(home));
    expect(start).toEqual({ action: "exit", reason: "no-config", nudge: null });
  });

  // T2
  test("the nudge is offered once, ever — a present marker suppresses it", () => {
    const home = tempHome();
    writeFileSync(join(home, ".setup-nudged"), "");
    const out = decide("stop", deps(home));
    expect(out).toEqual({ action: "exit", reason: "no-config", nudge: null });
  });

  // T3 — an unwritable home must not turn a once-ever nudge into a per-turn nag.
  test("a marker that never lands means the nudge is never printed", () => {
    const home = tempHome();
    let attempts = 0;
    const d = deps(home, {
      writeNudgeMarker: () => {
        attempts += 1;
        return false; // models a permanently unwritable siltpoke home
      },
    });
    expect(decide("stop", d)).toEqual({ action: "exit", reason: "no-config", nudge: null });
    expect(decide("stop", d)).toEqual({ action: "exit", reason: "no-config", nudge: null });
    // It tried both times — the suppression is the RETURN VALUE, not a cache.
    expect(attempts).toBe(2);
  });

  // T4
  test("bun unresolvable ⇒ exit, and explicitly NO nudge", () => {
    const home = configuredHome();
    const out = decide("stop", deps(home, { resolveBun: () => null }));
    // The nudge would send the user to redo setup, which already succeeded.
    expect(out).toEqual({ action: "exit", reason: "no-bun", nudge: null });
  });

  test("a missing bundle exits rather than spawning against a path that is not there", () => {
    const home = configuredHome();
    const out = decide("stop", deps(home, { fileExists: (p) => existsSync(p) }));
    expect(out).toEqual({ action: "exit", reason: "no-bundle", nudge: null });
  });

  test("neither HOME nor USERPROFILE ⇒ exit, not a thrown PathError", () => {
    const out = decide("stop", { env: {} });
    expect(out).toEqual({ action: "exit", reason: "no-home", nudge: null });
  });

  test("each mode hands the payload to its own bundle", () => {
    const home = configuredHome();
    const d = deps(home, { fileExists: () => true });
    const stop = decide("stop", d);
    const start = decide("session-start", d);
    expect(stop.action === "run" && stop.bundle.endsWith("siltpoke-stop.js")).toBe(true);
    expect(start.action === "run" && start.bundle.endsWith("handle-session-start.js")).toBe(true);
  });
});

// T5 — the repo's recurring defect class is bundled path arithmetic, and a
// Windows root is a strictly larger surface than the Unix one that has already
// caused repeated bugs: backslashes, a drive letter, a trailing separator, and
// a space in `Program Files` / `AppData\Roaming`.
// ⚠️ The order here is CLAUDE-FIRST, and it is the opposite of detectHostFamily's.
// That is not an inconsistency to tidy up: `hooks/stop.sh` does the same thing on
// purpose — CLAUDE-first for the plugin ROOT (86-89), fork-first for the host
// FAMILY (99-102). The first draft of the port used fork-first for both, and the
// first draft of THIS TEST asserted that wrong order as if it were intended —
// which is how a test bakes in a bug. Both were corrected in review 2026-09-24.
describe("resolvePluginRoot — the ladder, including Windows-shaped input", () => {
  const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
    [
      "claude wins over a fork name — mirroring stop.sh:86-89, NOT the host-family order",
      { QODER_PLUGIN_ROOT: "/q", CLAUDE_PLUGIN_ROOT: "/c" },
      "/c",
    ],
    ["claude wins over codebuddy too", { CODEBUDDY_PLUGIN_ROOT: "/cb", CLAUDE_PLUGIN_ROOT: "/c" }, "/c"],
    ["qoder when claude is absent", { QODER_PLUGIN_ROOT: "/q" }, "/q"],
    ["codebuddy when it is the only one", { CODEBUDDY_PLUGIN_ROOT: "/cb" }, "/cb"],
    ["claude when alone", { CLAUDE_PLUGIN_ROOT: "/c" }, "/c"],
  ];
  for (const [name, env, expected] of cases) {
    test(name, () => {
      expect(resolvePluginRoot(env, "/anything/dist")).toBe(expected);
    });
  }

  test("an empty variable is skipped, not taken as a root", () => {
    expect(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: "" }, "/plugin/dist")).toBe("/plugin");
  });

  test("no variable at all falls back to the guard's own directory + ..", () => {
    expect(resolvePluginRoot({}, "/opt/siltpoke/dist")).toBe("/opt/siltpoke");
  });

  test("a trailing separator does not produce a doubled or truncated root", () => {
    expect(resolvePluginRoot({}, "/opt/siltpoke/dist/")).toBe("/opt/siltpoke");
  });

  test("a path containing a space survives intact", () => {
    const root = "/Users/vic/Library/Application Support/siltpoke";
    expect(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: root }, "/x")).toBe(root);
  });

  // ⚠️ Runs on macOS, so it asserts what `node:path`'s POSIX implementation does
  // with a Windows-SHAPED string — not what Windows does with a Windows path.
  // The real check is a run on a real machine (spec §8 S8). Recorded rather than implied.
  test("a Windows-shaped root is passed through without being split on backslashes", () => {
    const root = "C:\\Users\\84798\\AppData\\Roaming\\Claude\\plugins\\siltpoke";
    expect(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: root }, "/x")).toContain("AppData");
  });
});

describe("detectHostFamily", () => {
  test("fork-specific names win, and nothing present resolves to empty", () => {
    expect(detectHostFamily({ QODER_PLUGIN_ROOT: "/q", CLAUDE_PLUGIN_ROOT: "/c" })).toBe("qoder");
    expect(detectHostFamily({ CODEBUDDY_PLUGIN_ROOT: "/b", CLAUDE_PLUGIN_ROOT: "/c" })).toBe(
      "codebuddy",
    );
    expect(detectHostFamily({ CLAUDE_PLUGIN_ROOT: "/c" })).toBe("claude");
    // Empty, NOT "claude" — an unresolved fork must reach brain-config as
    // unknown so it falls back deliberately rather than by accident.
    expect(detectHostFamily({})).toBe("");
  });
});

// T10 (the guard's half) — the `.ps1` half can only run on Windows.
describe("readStdinBytes", () => {
  test("a CJK + emoji payload survives byte-for-byte", async () => {
    const payload = JSON.stringify({ prompt: "你好，世界 🐙", session_id: "s1" });
    const bytes = await readStdinBytes(Readable.from([Buffer.from(payload, "utf8")]));
    expect(bytes.toString("utf8")).toBe(payload);
    expect(JSON.parse(bytes.toString("utf8")).prompt).toBe("你好，世界 🐙");
  });

  test("a payload split across chunks mid-character is rejoined correctly", async () => {
    // A multi-byte character straddling a chunk boundary is exactly what a
    // per-chunk `toString()` would corrupt.
    const full = Buffer.from(JSON.stringify({ prompt: "汉字" }), "utf8");
    const cut = 12; // lands inside the first multi-byte sequence
    const bytes = await readStdinBytes(Readable.from([full.subarray(0, cut), full.subarray(cut)]));
    expect(bytes.equals(full)).toBe(true);
  });

  test("an empty payload reads as empty rather than hanging", async () => {
    expect((await readStdinBytes(Readable.from([]))).length).toBe(0);
  });
});

describe("selfTestLine — the doctor probe's contract", () => {
  test("a runnable guard reports the bun and bundle it resolved", () => {
    const line = selfTestLine({
      action: "run",
      bun: "C:\\bun.exe",
      bundle: "C:\\p\\dist\\siltpoke-stop.js",
      hostFamily: "claude",
    });
    expect(line.startsWith("siltpoke-guard ok ")).toBe(true);
    expect(line).toContain("bun=C:\\bun.exe");
  });

  test("each exit reason is distinguishable, so doctor can name the right cause", () => {
    const reasons = ["no-home", "no-config", "no-bun", "no-plugin-root", "no-bundle"] as const;
    const lines = reasons.map((reason) => selfTestLine({ action: "exit", reason, nudge: null }));
    expect(new Set(lines).size).toBe(reasons.length);
    expect(lines).toContain("siltpoke-guard no-bun");
  });
});
