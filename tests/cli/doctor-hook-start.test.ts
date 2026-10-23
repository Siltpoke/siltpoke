// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The doctor row that explains why no review ever fires.
//
// The defect it exists for is not an error — it is an install that reports
// healthy and does nothing: the pet renders, the statusline works, config.json
// says setup succeeded, every other doctor row is green, and the Stop hook has
// never once executed. The guard's contract makes that silence mandatory, so
// this row is the only place a user can find out.
//
// The test that matters most here is "a blocked launcher is NOT reported as
// healthy". The obvious implementation — ask whether bun resolves — passes in
// exactly that case, because a Windows ExecutionPolicy or a Mark-of-the-Web
// stream stops the SCRIPT, not the interpreter. A check that can be green
// while the thing it stands for is broken would be this defect wearing the
// costume of its own fix.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReviewHookCanStart,
  HOOK_START_CHECK_NAME,
  SELF_TEST_TIMEOUT_MS,
  selfTestArgv,
} from "../../src/cli/doctor-hook-start-check";

/** A plugin root with the launcher present, so path checks pass. */
function installedPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "siltpoke-plugin-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "siltpoke-hook.ps1"), "# launcher\n");
  return root;
}

function win(stdout: string, ok = true, root = installedPluginRoot()) {
  return checkReviewHookCanStart({
    platform: "win32",
    pluginRootPath: root,
    runSelfTest: () => ({ stdout, ok }),
  });
}

describe("Windows — the row runs the launcher rather than asking about it", () => {
  test("a launcher PowerShell refuses to run fails, and names the two known causes", () => {
    const r = win("", false);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("ExecutionPolicy");
    expect(r.detail).toContain("Mark-of-the-Web");
    // Must not send the user to install bun — bun is not the problem, and
    // conflating the two is how somebody spends an afternoon on the wrong fix.
    expect(r.detail).not.toContain("bun.sh");
  });

  test("a launcher that runs but finds no bun fails, and names bun specifically", () => {
    const r = win("siltpoke-guard no-bun");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("bun.sh");
    // The opposite mis-routing: this one is NOT a policy problem.
    expect(r.detail).not.toContain("ExecutionPolicy");
  });

  test("a hook that cannot find its own files fails and says so", () => {
    // `no-guard` is the LAUNCHER's reason (the guard bundle is missing, so the
    // guard never spoke at all); the other three come from the guard itself.
    for (const reason of ["no-bundle", "no-plugin-root", "no-home", "no-guard"]) {
      const r = win(`siltpoke-guard ${reason}`);
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("reinstall");
    }
  });

  test("output that is not the sentinel is treated as 'did not run'", () => {
    // A launcher that prints something else has not proven anything. Trusting
    // unrecognized output would be the vacuous-pass shape again.
    const r = win("some unrelated powershell noise", true);
    expect(r.pass).toBe(false);
  });

  test("a missing launcher file fails before anything is spawned", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-empty-"));
    const r = checkReviewHookCanStart({
      platform: "win32",
      pluginRootPath: root,
      runSelfTest: () => {
        throw new Error("must not be called");
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("missing");
  });
});

// Reason codes are a list, and a list is a thing somebody forgets to extend.
// `internal-error` was in the guard's union and in nothing here, so the one row
// whose job is to explain a silent hook put a green tick on the guard crashing.
describe("Windows — the row answers its own question, with nothing overlaid", () => {
  // Re-registered 2026-09-26. Between 09-25 and 09-26 these two asserted the
  // opposite: that the row SAID the entry was withdrawn. That was right while
  // it was — a ✓ for a launcher nothing invokes is the `[23]` failure this row
  // exists to delete — and it is wrong now, for the mirrored reason: a "NOT
  // registered" qualifier on an entry that IS registered is the same lie with
  // the sign flipped.
  test("a working launcher passes, and says what it resolved", () => {
    const r = win("siltpoke-guard ok bun=C:/bun.exe bundle=C:/p/dist/siltpoke-stop.js");
    expect(r.name).toBe(HOOK_START_CHECK_NAME);
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("bun=C:/bun.exe");
    // The withdrawal wording must not survive anywhere: it is now false.
    expect(r.detail ?? "").not.toContain("NOT registered");
    expect(r.detail ?? "").not.toContain("No review fires on Windows today");
  });

  test("the row does not claim the review will SUCCEED — only that the hook starts", () => {
    // On Windows that depends on the reviewer CLI. `[26]` now covers all five,
    // but only `claude`'s route has been exercised on Windows. Those belong to
    // the brain rows, and this row over-claiming them would be a green tick
    // standing in for an answer it never checked.
    const r = win("siltpoke-guard ok bun=C:/bun.exe bundle=C:/p/dist/siltpoke-stop.js");
    for (const overclaim of ["review will", "reviews will", "a review fires"]) {
      expect((r.detail ?? "").toLowerCase()).not.toContain(overclaim);
    }
  });

  // THE test. A bun-resolvability check would return pass here.

  test("setup not run yet is a warning, not a failure — and says setup is not what is missing", () => {
    // The plugin is live before /siltpoke:siltpoke-setup by design. Failing here would
    // red every fresh install for doing nothing wrong — so the warning, its
    // status and its advice all stay.
    const r = win("siltpoke-guard no-config");
    expect(r.pass).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("/siltpoke:siltpoke-setup");
    // Was asserting the withdrawal note here too, 2026-09-25 → 09-26. With the
    // entry registered again, "finish setup and reviews will start" is true on
    // Windows for a `claude`/`codebuddy` reviewer, so the advice stands alone.
    expect(r.detail ?? "").not.toContain("NOT registered");
  });
});

describe("Windows — every reason code is accounted for", () => {
  test("the guard crashing is a FAILURE, not a green tick", () => {
    // `internal-error` is a real reason `hook-guard.ts` emits, and it had no
    // branch here — it fell through to the final `return row(true, …)`. So the
    // one row whose entire job is to explain a silent hook reported the guard
    // blowing up as healthy. Every other reason is enumerated; this is the test
    // that stops the enumeration from being a list somebody forgets to extend.
    const r = win("siltpoke-guard internal-error");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("hook-guard-errors.jsonl");
    // Not blamed on the two things it is not.
    expect(r.detail).not.toContain("ExecutionPolicy");
    expect(r.detail).not.toContain("bun.sh");
  });

  test("every reason the guard can emit has a branch here", () => {
    // The enumeration above is only as good as its coverage of the source of
    // truth. `internal-error` was missing precisely because nothing compared the
    // two lists. Reading GuardOutcome's union keeps them in step by force.
    const core = readFileSync(
      join(import.meta.dir, "..", "..", "src", "hooks", "hook-guard-core.ts"),
      "utf8",
    );
    const union = core.slice(core.indexOf('reason: "'), core.indexOf("/** The text to print"));
    const reasons = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(4);
    for (const reason of reasons) {
      const r = win(`siltpoke-guard ${reason}`);
      // `no-config` is the one reason that is deliberately not a failure.
      if (reason === "no-config") continue;
      expect({ reason, pass: r.pass }).toEqual({ reason, pass: false });
    }
  });
});

describe("Unix — reports, never blocks", () => {
  test("bun resolvable: passes, and says WHOSE shell resolved it", () => {
    const r = checkReviewHookCanStart({
      platform: "darwin",
      resolveBun: () => "/usr/local/bin/bun",
    });
    expect(r.pass).toBe(true);
    // The row's name promises more than doctor can know on Unix, so the detail
    // says which shell answered rather than implying the hook's was probed.
    expect(r.detail).toContain("doctor's shell");
  });

  test("bun unresolvable: warns, and CANNOT enter the fail count", () => {
    const r = checkReviewHookCanStart({ platform: "linux", resolveBun: () => null });
    // pass:true is what keeps it out of the fail count (doctor.ts:652).
    // Defects [20]/[21] are precisely doctor's PATH differing from the hook's,
    // so a blocking row built on doctor's PATH would ship a new false red to
    // every existing Unix install.
    expect(r.pass).toBe(true);
    expect(r.status).toBe("warn");
  });

  test("the Unix path never spawns a launcher", () => {
    checkReviewHookCanStart({
      platform: "darwin",
      resolveBun: () => "/bun",
      runSelfTest: () => {
        throw new Error("must not be called on Unix");
      },
    });
  });
});

// Everything above this line injects past the two lines that do the real work.
// That is how a probe flag which could never bind, and a plugin-root lookup
// which could never succeed on Windows, went green through a full gate — the
// repo's "delivery half has no assertions" defect, twice in one file.
describe("the delivery half — what actually gets spawned, and where it looks", () => {
  test("the probe is spawned with a PowerShell switch, not the bundle's flag", () => {
    const argv = selfTestArgv("C:/p/hooks/siltpoke-hook.ps1");
    expect(argv).toContain("-SelfTest");
    // THE assertion. PowerShell 5.1 binds any `-`-prefixed token on a `-File`
    // command line as a parameter NAME, so `--self-test` asks for a parameter
    // called `-self-test`, matches none, and terminates the launcher before its
    // first statement — on a HEALTHY machine. Every test in this file mocked
    // that spawn away, so the row reported "PowerShell could not run the review
    // hook" on every working Windows install and nothing here noticed.
    expect(argv).not.toContain("--self-test");
    expect(argv.join(" ")).not.toContain("--self-test");
    // -File, and the launcher path immediately after it, so a reordering that
    // turned the path into an argument of something else would fail here.
    expect(argv[argv.indexOf("-File") + 1]).toBe("C:/p/hooks/siltpoke-hook.ps1");
    // The mode the hook is being probed in. The launcher treats anything that
    // is not `session-start` as `stop`, but naming it keeps the probe honest.
    expect(argv).toContain("stop");
  });

  test("the probe's timeout leaves room for two cold Windows process starts", () => {
    // 2000ms was the first draft, against powershell + bun both possibly being
    // scanned by Defender. A tight timeout here does not fail safe: it reds a
    // healthy install and sends the user to fix an ExecutionPolicy.
    expect(SELF_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    // And it must outlast the launcher's own self-test bound, so the timeout
    // that fires first is the one that can still kill bun rather than orphan it.
    const launcher = readFileSync(
      join(import.meta.dir, "..", "..", "hooks", "siltpoke-hook.ps1"),
      "utf8",
    );
    const inner = Number(launcher.match(/WaitForExit\((\d+)\)/)?.[1] ?? 0);
    expect(inner).toBeGreaterThan(0);
    expect(SELF_TEST_TIMEOUT_MS).toBeGreaterThan(inner);
  });

});

// The other half of the delivery gap: where the row goes looking for the
// launcher at all. Injected past by every test above.
describe("the delivery half — which home the plugin root is read from", () => {
  test("the plugin root is read from the user's home, not from $HOME", () => {
    // Windows does not set HOME, it sets USERPROFILE. The first draft read
    // `process.env.HOME ?? ""` three lines below a call that handles that
    // correctly, so on the one platform this branch runs on it reported every
    // healthy install as "cannot locate the plugin directory — reinstall".
    //
    // The assertion is on the RESOLVED path, not on the pass/fail: on a machine
    // that happens to have a real ~/.siltpoke/plugin-root, reading the wrong
    // home still lands somewhere plausible and a pass/fail check would be
    // satisfied by the bug.
    const home = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "siltpoke-pointed-"));
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "plugin-root"), pluginRoot);

    // No launcher inside it, so the detail names the path it looked at.
    const r = checkReviewHookCanStart({
      platform: "win32",
      home,
      runSelfTest: () => ({ stdout: "", ok: false }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain(join(pluginRoot, "hooks", "siltpoke-hook.ps1"));
  });

  test("a home with no pointer file is 'cannot locate', not a crash", () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-bare-home-"));
    const r = checkReviewHookCanStart({
      platform: "win32",
      home,
      runSelfTest: () => {
        throw new Error("must not be called without a plugin root");
      },
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("cannot locate");
  });
});

describe("the row is registered", () => {
  test("runAllChecks includes it", async () => {
    const { runAllChecks } = await import("../../src/cli/doctor");
    const names = runAllChecks({ platform: "darwin" }).map((r) => r.name);
    expect(names).toContain(HOOK_START_CHECK_NAME);
  });
});
