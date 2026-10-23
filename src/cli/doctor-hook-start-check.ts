// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * "Can the review hook actually start?" — the row that explains the silence.
 *
 * WHY IT EXISTS. The Stop hook's contract is that nothing it does may reach the
 * user's session, so every failure is a silent `exit 0`. That is correct, and
 * it leaves a hole: a user whose hook cannot start sees a pet, a working
 * statusline, a config file saying "installed", and no review, ever, with
 * nothing anywhere saying why. This row is where the silence gets explained.
 * It is what turns "reviews do not fire" from a defect into a choice.
 *
 * WHY IT RUNS THE LAUNCHER INSTEAD OF ASKING ABOUT IT. The obvious check is
 * "is bun resolvable". That is a PROXY, and it reports green in the case that
 * matters most: if Windows refuses to execute the launcher — an ExecutionPolicy
 * set by group policy, or the Mark-of-the-Web stream a DOWNLOADED script
 * carries, and a plugin install is a download — then bun still resolves fine,
 * the proxy passes, and reviews still never fire. A check that can be green
 * while the thing it stands for is broken is the same defect this row exists to
 * remove. So it runs `siltpoke-hook.ps1 -SelfTest` and asserts the sentinel.
 *
 * WHY IT IS WARN-ONLY ON UNIX. Doctor runs from an interactive shell; the hook
 * runs from a non-login one. That asymmetry IS defects [20]/[21] — bun on the
 * user's PATH but not the hook's — so a doctor-side resolution is not evidence
 * about the hook's environment, and a blocking Unix row built on it would ship
 * a new false red to every existing install. Windows has no login/non-login
 * split, which is exactly why the probe means something there and only there.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBunPath } from "../installer/bun-path";
import { siltpokeRoot } from "../installer/paths";
import { resolvePluginRoot } from "../installer/shim";
import type { CheckResult, DoctorOptions } from "./doctor";

export const HOOK_START_CHECK_NAME = "review hook can start";

/** The one line `--self-test` prints. Kept in step with `selfTestLine`. */
const SENTINEL = "siltpoke-guard";

export interface HookStartDeps {
  /**
   * Where the plugin is installed. Injected rather than resolved here so the
   * Windows branch is reachable from a macOS test.
   */
  pluginRootPath?: string;
  /**
   * Run the Windows launcher in self-test mode and return what it printed.
   *
   * Injected so the outcomes below are reachable from a macOS test. A real
   * implementation spawns `powershell -NoProfile -ExecutionPolicy Bypass
   * -File <root>/hooks/siltpoke-hook.ps1 stop -SelfTest`.
   */
  runSelfTest?: () => { stdout: string; ok: boolean };
  /** Resolve bun the way the hook would. Defaults to the shared resolver. */
  resolveBun?: (home: string) => string | null;
}

function row(pass: boolean, detail: string, status?: CheckResult["status"]): CheckResult {
  return { name: HOOK_START_CHECK_NAME, pass, detail, ...(status ? { status } : {}) };
}

/**
 * On Unix, report what we can and never block.
 *
 * Deliberately thin: the honest answer here is "bun looks resolvable from
 * doctor's shell", which is a weaker claim than the row's name, so it says so
 * rather than implying it probed the hook.
 */
function unixRow(home: string, resolveBun: (home: string) => string | null): CheckResult {
  const bun = resolveBun(home);
  if (bun) return row(true, `bun resolves to ${bun} (from doctor's shell)`, "pass");
  return row(
    true,
    "bun not resolvable from doctor's shell — reviews may be silent. " +
      "Install bun (https://bun.sh) or re-run setup so its path is recorded.",
    "warn",
  );
}

/**
 * Windows: run the launcher, and read its outcomes apart — one branch per
 * reason code, and a reason with no branch is a bug, not a pass.
 *
 * "Launcher never ran" and "launcher ran and found no bun" are DIFFERENT
 * failures with different fixes, and collapsing them is what leaves a user
 * installing bun to fix a policy problem.
 */
function windowsRow(pluginRoot: string | null, runSelfTest: () => { stdout: string; ok: boolean }) {
  if (!pluginRoot) {
    return row(false, "cannot locate the plugin directory — reinstall the plugin");
  }
  const launcher = join(pluginRoot, "hooks", "siltpoke-hook.ps1");
  if (!existsSync(launcher)) {
    return row(false, `the Windows launcher is missing (${launcher}) — reinstall the plugin`);
  }

  const { stdout, ok } = runSelfTest();
  const line = stdout.trim();
  // The guard's reason is the LAST whitespace-separated token, compared whole.
  // `includes()` is wrong here and was: "no-bundle" contains "no-bun", so a
  // missing bundle reported itself as a missing interpreter and sent the user
  // to install bun to fix a file that simply was not there. Substring matching
  // on a reason code is the same shape as every other too-loose match this
  // repo has paid for.
  const reason = line.split(/\s+/).pop() ?? "";

  if (!ok || !line.startsWith(SENTINEL)) {
    // The case a bun-resolvability check would have called green.
    return row(
      false,
      "PowerShell could not run the review hook. The two known causes are an " +
        "ExecutionPolicy that blocks unsigned scripts, and the Mark-of-the-Web " +
        "on a downloaded file (try: Unblock-File on the plugin's hooks folder).",
    );
  }
  if (reason === "no-bun") {
    return row(
      false,
      "the hook starts, but bun is not installed or not on PATH. " +
        'Install it with: powershell -c "irm bun.sh/install.ps1 | iex", then open a new terminal.',
    );
  }
  if (reason === "no-config") {
    // Not a failure. The plugin is live before setup has run, by design.
    return row(true, "the hook starts; run /siltpoke:siltpoke-setup to create your pet", "warn");
  }
  if (
    reason === "no-bundle" ||
    reason === "no-plugin-root" ||
    reason === "no-home" ||
    reason === "no-guard"
  ) {
    // `no-guard` is the launcher's own reason — the guard bundle it hands over
    // to is not there, so nothing downstream ever started. The wording avoids
    // "the hook starts", which is true of the other three and false of it.
    return row(false, `the launcher runs but the plugin's files are incomplete (${line}) — reinstall`);
  }
  if (reason === "internal-error") {
    // The guard hit something it did not anticipate and logged it. Without this
    // branch the reason fell through to the `pass` return below — so the one row
    // that exists to explain a silent hook put a green tick on the guard
    // crashing. `hook-guard.ts` writes the detail; point at it rather than
    // paraphrase, because the paraphrase is what went missing here.
    return row(
      false,
      "the hook starts but the guard failed unexpectedly — see " +
        "~/.siltpoke/hook-guard-errors.jsonl, and please report it",
    );
  }
  return row(true, line.replace(`${SENTINEL} ok `, ""), "pass");
}

/**
 * How long the probe may take before the answer is "it did not run".
 *
 * 8s, not the 2s of the first draft: two cold process starts on Windows, both
 * plausibly being scanned by Defender, is not a two-second budget, and the
 * penalty for being tight is a false ✗ on a working install. It is deliberately
 * LONGER than the launcher's own 5s self-test bound, so that the bound firing
 * first is normally the one that can still kill bun rather than orphan it —
 * `spawnSync`'s timeout reaps powershell.exe and never its grandchild.
 *
 * A preference, not a guarantee: the launcher's 5s starts when its script body
 * reaches that line, while this 8s is wall-clock from the spawn, so PowerShell's
 * own start-up eats the margin. See the residual noted at that line.
 */
export const SELF_TEST_TIMEOUT_MS = 8000;

/**
 * The exact argv the probe spawns.
 *
 * An argv array rather than a shell string: the plugin root on Windows
 * routinely contains spaces (`AppData\\Roaming`, `Program Files`), and a shell
 * string is one more quoting layer to get wrong in a file whose failure mode is
 * silence.
 *
 * `-SelfTest`, a PowerShell switch, NOT the `--self-test` the guard bundle
 * takes. PowerShell 5.1 binds any `-`-prefixed token on a `-File` command line
 * as a parameter NAME, so `--self-test` terminates the launcher before its
 * first statement — on a healthy machine. The launcher forwards the bundle's
 * own `--self-test` itself. See `hooks/siltpoke-hook.ps1`'s `$SelfTest` param.
 *
 * Extracted from the spawn so it can be asserted at all. This command line and
 * the plugin-root resolution below are the DELIVERY half of this row: every
 * test injected past both, so the two lines that do the real work were executed
 * by nothing, and a flag that could never bind went green through a full gate.
 */
export function selfTestArgv(launcher: string): string[] {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "stop", "-SelfTest"];
}

/** Actually run the launcher, self-test mode. Every failure reads as "did not run". */
function defaultRunSelfTest(launcher: string): { stdout: string; ok: boolean } {
  try {
    const r = spawnSync("powershell", selfTestArgv(launcher), {
      encoding: "utf8",
      timeout: SELF_TEST_TIMEOUT_MS,
      input: "{}",
    });
    return { stdout: r.stdout ?? "", ok: r.status === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

export function checkReviewHookCanStart(
  opts: DoctorOptions & HookStartDeps = {},
): CheckResult {
  const platform = opts.platform ?? process.platform;
  const home = siltpokeRoot(process.env);
  const resolveBun = opts.resolveBun ?? ((h: string) => resolveBunPath(h));

  if (platform !== "win32") return unixRow(home, resolveBun);

  // The pointer the plugin's SessionStart hook writes. Injected in tests so
  // the Windows branch is reachable from macOS.
  //
  // `homedir()`, NOT `process.env.HOME`: Windows does not set HOME, it sets
  // USERPROFILE, so reading HOME on the one platform this branch runs on
  // yields "" and reports every healthy install as "cannot locate the plugin
  // directory — reinstall the plugin". The first draft did exactly that, three
  // lines below a call that handles it correctly. `homedir()` rather than
  // `siltpokeRoot(...)` because the pointer files are addressed from the RAW
  // home — the shell readers of `plugin-root` and `bun-path` know nothing of
  // SILTPOKE_HOME — which is also why `doctor-plugin-install.ts:35` resolves it
  // this same way. Caught in review, 2026-09-24.
  const pluginRoot = opts.pluginRootPath ?? resolvePluginRoot(opts.home ?? homedir());
  const runSelfTest =
    opts.runSelfTest ??
    (() => defaultRunSelfTest(join(pluginRoot ?? "", "hooks", "siltpoke-hook.ps1")));
  const row = windowsRow(pluginRoot, runSelfTest);

  // Re-registered 2026-09-26: `hooks/hooks.json` carries the PowerShell Stop
  // and SessionStart entries again, so this row's answer stands on its own
  // once more and nothing is overlaid on it.
  //
  // What used to sit here said "the launcher starts, but nothing invokes it".
  // It existed because a green row for a component nothing calls is the `[23]`
  // failure this row was added to delete. That is no longer true, and keeping
  // the sentence would be the same fault mirrored: a red qualifier on a
  // component that now really does run.
  //
  // What this row deliberately does NOT claim: that the review will SUCCEED.
  // On Windows that depends on the reviewer CLI, and `[26]` now covers all five
  // — though only `claude`'s route has actually been exercised on Windows. The
  // reviewer is what `checkBrainHealth` and the brain-role rows are for. This
  // row answers its own name and nothing beyond it.
  return row;
}
