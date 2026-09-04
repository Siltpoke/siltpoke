import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
let home: string;

// Prefer dash over the platform `sh`. macOS's /bin/sh is bash, which is lenient
// about POSIX edge cases the guard must survive (e.g. a redirection failure on a
// special builtin, which bash tolerates but dash treats as fatal — a real
// Linux-CI-only crash slipped through because the guard was only ever tested
// under macOS bash). Running under dash locally catches that class before CI.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

function runGuard(env: Record<string, string>) {
  return Bun.spawnSync([SHELL, join(REPO, "hooks", "stop.sh")], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: REPO, ...env },
    stdin: new TextEncoder().encode('{"session_id":"t"}'),
  });
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "siltpoke-guard-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("stop.sh guard", () => {
  test("no ~/.siltpoke/config.json → exit 0, nudge ONCE on stderr", () => {
    const first = runGuard({});
    expect(first.exitCode).toBe(0);
    expect(new TextDecoder().decode(first.stderr)).toContain("/siltpoke-setup");
    expect(existsSync(join(home, ".siltpoke", ".nudged"))).toBe(true);

    // Second turn: still exit 0, but SILENT — a nudge every turn is spam.
    const second = runGuard({});
    expect(second.exitCode).toBe(0);
    expect(new TextDecoder().decode(second.stderr)).toBe("");
  });

  test("bun missing → exit 0, silent after the first nudge", () => {
    // Empty PATH ⇒ `command -v bun` finds nothing.
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    writeFileSync(join(home, ".siltpoke", ".nudged"), "");
    const r = runGuard({ PATH: "" });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("CLAUDE_PLUGIN_ROOT unset → falls back to $0 resolution, still exits 0 with no shell crash", () => {
    // The hook's own command string interpolates ${CLAUDE_PLUGIN_ROOT}, so in
    // practice it's always populated — but this guard must never trust that.
    //
    // Task 1 (multi-host plugin-root fallback) made "unset" no longer mean
    // "do nothing": the guard now falls back to resolving the plugin root
    // from its own location ($0/..), which — run from this real repo
    // checkout, as this test does — resolves to REPO and finds the REAL
    // dist/siltpoke-stop.js. So it actually executes the real bundle, and
    // stderr is no longer guaranteed empty (the bundle can log its own
    // warnings, as it does here). What this regression test still guards is
    // that the SHELL ITSELF never emits an "unbound variable" / "parameter
    // not set" crash — the `set -u` safety this test originally existed for.
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    writeFileSync(join(home, ".siltpoke", ".nudged"), "");
    const r = Bun.spawnSync(["sh", join(REPO, "hooks", "stop.sh")], {
      env: (() => {
        const e: Record<string, string | undefined> = { ...process.env, HOME: home };
        delete e.CLAUDE_PLUGIN_ROOT;
        return e;
      })(),
      stdin: new TextEncoder().encode('{"session_id":"t"}'),
    });
    const stderr = new TextDecoder().decode(r.stderr);
    expect(r.exitCode).toBe(0);
    expect(stderr).not.toContain("unbound variable");
    expect(stderr).not.toContain("parameter not set");
  });

  test("dist/siltpoke-stop.js missing → exit 0, silent (no nudge — install looks fine otherwise)", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const fakeRoot = mkdtempSync(join(tmpdir(), "siltpoke-root-"));
    const r = runGuard({ CLAUDE_PLUGIN_ROOT: fakeRoot });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  test("happy path: config + bun + bundle present → pipes stdin into the bundle, exits 0", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const fakeRoot = mkdtempSync(join(tmpdir(), "siltpoke-root-"));
    mkdirSync(join(fakeRoot, "dist"), { recursive: true });
    writeFileSync(
      join(fakeRoot, "dist", "siltpoke-stop.js"),
      "process.stdout.write('bundle-ran:' + require('fs').readFileSync(0, 'utf8'));",
    );
    const r = runGuard({ CLAUDE_PLUGIN_ROOT: fakeRoot });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    expect(new TextDecoder().decode(r.stdout)).toBe('bundle-ran:{"session_id":"t"}');
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  test("bundle crashes → guard still exits 0 (bundle logs its own fatals)", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const fakeRoot = mkdtempSync(join(tmpdir(), "siltpoke-root-"));
    mkdirSync(join(fakeRoot, "dist"), { recursive: true });
    writeFileSync(join(fakeRoot, "dist", "siltpoke-stop.js"), "throw new Error('boom');");
    const r = runGuard({ CLAUDE_PLUGIN_ROOT: fakeRoot });
    expect(r.exitCode).toBe(0);
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  test("HOME unset → exit 0, no 'unbound variable' crash under set -u", () => {
    // Regression for the bare ${HOME} crash: HOME collapses to "" so the
    // script looks at /.siltpoke/config.json (never present as a non-root
    // user), which legitimately routes through nudge_once — the ONE allowed
    // stderr line. What must NOT appear is the shell's own crash text.
    const r = Bun.spawnSync(["sh", join(REPO, "hooks", "stop.sh")], {
      env: (() => {
        const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO };
        delete e.HOME;
        return e;
      })(),
      stdin: new TextEncoder().encode('{"session_id":"t"}'),
    });
    const stderr = new TextDecoder().decode(r.stderr);
    expect(r.exitCode).toBe(0);
    // Crash wording differs by shell (bash: "unbound variable", dash: "parameter
    // not set") — assert on the variable name, which appears in both, so this
    // stays meaningful under whatever /bin/sh CI resolves to.
    expect(stderr).not.toContain("unbound variable");
    expect(stderr).not.toContain("parameter not set");
    expect(stderr).not.toContain("HOME");
  });

  test("~/.siltpoke read-only → exit 0, no 'Permission denied' leak from nudge_once", () => {
    // Regression for the redirect-order bug: `: > "$NUDGE_MARKER" 2>/dev/null`
    // applied the file redirect before the stderr redirect, so an unwritable
    // $SILTPOKE_DIR leaked "Permission denied" onto the shell's real stderr
    // before 2>/dev/null ever took effect. config.json + the marker are both
    // absent (fresh home dir) so nudge_once actually attempts the write.
    const siltpokeDir = join(home, ".siltpoke");
    mkdirSync(siltpokeDir, { recursive: true });
    chmodSync(siltpokeDir, 0o555);
    try {
      const r = runGuard({});
      const stderr = new TextDecoder().decode(r.stderr);
      expect(r.exitCode).toBe(0);
      expect(stderr).not.toContain("Permission denied");
      // The marker write fails (dir unwritable), so nudge_once can't persist
      // "once ever" — it must stay silent rather than nudge unconditionally.
      // See the dedicated read-only-forever test below for the full story.
      expect(stderr).toBe("");
    } finally {
      chmodSync(siltpokeDir, 0o755);
    }
  });

  test("~/.siltpoke permanently read-only, no marker → silent on EVERY run, not just once", () => {
    // Regression for: nudge_once() used to print unconditionally after
    // attempting the marker write, regardless of whether the write actually
    // landed. If ~/.siltpoke is permanently unwritable, the marker can never
    // be created — so the old code nudged on every single Stop hook, forever,
    // which is exactly the per-turn spam the once-ever marker exists to
    // prevent. Fix: only print if the marker file actually exists after the
    // write attempt. A silent Siltpoke beats one that nags every turn.
    const siltpokeDir = join(home, ".siltpoke");
    mkdirSync(siltpokeDir, { recursive: true });
    chmodSync(siltpokeDir, 0o555);
    try {
      const first = runGuard({});
      expect(first.exitCode).toBe(0);
      expect(new TextDecoder().decode(first.stderr)).toBe("");
      expect(existsSync(join(siltpokeDir, ".nudged"))).toBe(false);

      const second = runGuard({});
      expect(second.exitCode).toBe(0);
      expect(new TextDecoder().decode(second.stderr)).toBe("");
    } finally {
      chmodSync(siltpokeDir, 0o755);
    }
  });
});

describe("session-start.sh", () => {
  function runSessionStart(env: Record<string, string>) {
    return Bun.spawnSync(["sh", join(REPO, "hooks", "session-start.sh")], {
      env: { ...process.env, HOME: home, ...env },
      stdin: new TextEncoder().encode("{}"),
    });
  }

  test("writes CLAUDE_PLUGIN_ROOT to ~/.siltpoke/plugin-root atomically", () => {
    const r = runSessionStart({ CLAUDE_PLUGIN_ROOT: "/some/versioned/cache/path" });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    const written = join(home, ".siltpoke", "plugin-root");
    expect(existsSync(written)).toBe(true);
    expect(existsSync(join(home, ".siltpoke", "plugin-root.tmp"))).toBe(false);
  });

  test("CLAUDE_PLUGIN_ROOT unset → exit 0, no crash under set -u", () => {
    const r = Bun.spawnSync(["sh", join(REPO, "hooks", "session-start.sh")], {
      env: (() => {
        const e: Record<string, string | undefined> = { ...process.env, HOME: home };
        delete e.CLAUDE_PLUGIN_ROOT;
        return e;
      })(),
      stdin: new TextEncoder().encode("{}"),
    });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("HOME unset → exit 0, empty stderr (regression for bare HOME expansion crash)", () => {
    // session-start.sh has no allowed-exception output at all (unlike
    // stop.sh's once-ever nudge), so stderr must be literally empty here.
    const r = Bun.spawnSync(["sh", join(REPO, "hooks", "session-start.sh")], {
      env: (() => {
        const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO };
        delete e.HOME;
        return e;
      })(),
      stdin: new TextEncoder().encode("{}"),
    });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("~/.siltpoke read-only → exit 0, empty stderr (regression for redirect-order leak)", () => {
    // Regression for: `printf ... > "$TMP" 2>/dev/null` applies the file
    // redirect before the stderr redirect, leaking "Permission denied" onto
    // the shell's real stderr when $SILTPOKE_DIR is unwritable.
    const siltpokeDir = join(home, ".siltpoke");
    mkdirSync(siltpokeDir, { recursive: true });
    chmodSync(siltpokeDir, 0o555);
    try {
      const r = runSessionStart({ CLAUDE_PLUGIN_ROOT: REPO });
      expect(r.exitCode).toBe(0);
      expect(new TextDecoder().decode(r.stderr)).toBe("");
    } finally {
      chmodSync(siltpokeDir, 0o755);
    }
  });
});

describe("plugin root resolution fallback ($0)", () => {
  test("stop.sh resolves plugin root from $0 when no *_PLUGIN_ROOT env var is set", () => {
    // Simulates a CC-fork host (qoder/codebuddy) that doesn't export
    // CLAUDE_PLUGIN_ROOT (or any *_PLUGIN_ROOT var) at all: build a real
    // plugin-dir layout in a temp root, copy the REAL checked-in wrapper into
    // it verbatim, and confirm the wrapper resolves its own plugin root from
    // $0 (hooks/ -> parent) rather than doing nothing.
    const root = mkdtempSync(join(tmpdir(), "siltpoke-plugin-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    // A fake bundle that prints a sentinel so we can prove the wrapper
    // reached THIS root's dist (not the repo's real dist/siltpoke-stop.js).
    writeFileSync(join(root, "dist", "siltpoke-stop.js"), `console.log("REACHED");`);
    const wrapperSrc = readFileSync(join(REPO, "hooks", "stop.sh"), "utf8");
    writeFileSync(join(root, "hooks", "stop.sh"), wrapperSrc);

    const fakeHome = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
    mkdirSync(join(fakeHome, ".siltpoke"), { recursive: true });
    writeFileSync(join(fakeHome, ".siltpoke", "config.json"), "{}");

    try {
      const r = Bun.spawnSync([SHELL, join(root, "hooks", "stop.sh")], {
        env: { HOME: fakeHome, PATH: process.env.PATH ?? "" }, // NOTE: no *_PLUGIN_ROOT
        stdin: new TextEncoder().encode("{}"),
      });
      expect(new TextDecoder().decode(r.stdout)).toContain("REACHED");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("session-start.sh resolves AND PERSISTS the correct plugin root from $0 when no *_PLUGIN_ROOT env var is set", () => {
    // Mirrors the stop.sh sentinel test above, but for session-start.sh's
    // copy of the same fallback chain. stop.sh's sentinel test proves $0
    // resolution reaches the right dir by observing bundle execution
    // (stdout "REACHED") — session-start.sh never executes anything, it only
    // persists the resolved path to a file, so the only way to prove ITS
    // copy of the chain is correct (right ".." depth, right var names, not a
    // silently-empty write) is to read back the file content and assert it
    // equals the temp root, not just that the write succeeded.
    const root = mkdtempSync(join(tmpdir(), "siltpoke-plugin-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    const wrapperSrc = readFileSync(join(REPO, "hooks", "session-start.sh"), "utf8");
    writeFileSync(join(root, "hooks", "session-start.sh"), wrapperSrc);

    const fakeHome = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
    mkdirSync(join(fakeHome, ".siltpoke"), { recursive: true });
    writeFileSync(join(fakeHome, ".siltpoke", "config.json"), "{}");

    try {
      const r = Bun.spawnSync([SHELL, join(root, "hooks", "session-start.sh")], {
        env: { HOME: fakeHome, PATH: process.env.PATH ?? "" }, // NOTE: no *_PLUGIN_ROOT
        stdin: new TextEncoder().encode("{}"),
      });
      expect(r.exitCode).toBe(0);
      expect(new TextDecoder().decode(r.stderr)).toBe("");
      const writtenPath = join(fakeHome, ".siltpoke", "plugin-root");
      expect(existsSync(writtenPath)).toBe(true);
      expect(readFileSync(writtenPath, "utf8")).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// Slice A (T1) — the stop wrappers MUST export SILTPOKE_HOST so brain-config can
// default `review` to the builder family. This wiring is otherwise untested
// (shell) and trivial to silently drop, which would make the whole feature inert.
describe("stop wrappers export SILTPOKE_HOST (builder-family wiring)", () => {
  test("codex-stop.sh sets SILTPOKE_HOST=codex on the bun invocation", () => {
    const s = readFileSync(join(REPO, "hooks", "codex-stop.sh"), "utf8");
    expect(s).toMatch(/SILTPOKE_HOST=codex\s+bun\b/);
  });

  test("agy-stop.sh sets SILTPOKE_HOST=agy on the bun invocation", () => {
    const s = readFileSync(join(REPO, "hooks", "agy-stop.sh"), "utf8");
    expect(s).toMatch(/SILTPOKE_HOST=agy\s+bun\b/);
  });

  test("stop.sh derives SILTPOKE_HOST from the fork's *_PLUGIN_ROOT and passes it to bun", () => {
    const s = readFileSync(join(REPO, "hooks", "stop.sh"), "utf8");
    // fork-specific detection present (qoder + codebuddy + claude families)
    expect(s).toContain("QODER_PLUGIN_ROOT");
    expect(s).toContain("CODEBUDDY_PLUGIN_ROOT");
    expect(s).toMatch(/SILTPOKE_HOST_FAMILY="qoder"/);
    expect(s).toMatch(/SILTPOKE_HOST_FAMILY="codebuddy"/);
    expect(s).toMatch(/SILTPOKE_HOST_FAMILY="claude"/);
    // and it is passed to the reviewer bun invocation
    expect(s).toMatch(/SILTPOKE_HOST="\$SILTPOKE_HOST_FAMILY"\s+bun\b/);
  });

  // Runtime precedence — mirrors the "REACHED" sentinel test above (real bun runs
  // a fake bundle that echoes the env it was given), so a broken detection ORDER
  // is caught, not just a missing literal. This is the rigor the static test lacks.
  // `exportFamilies` names the *_PLUGIN_ROOT vars to export; all point at the SAME
  // temp root so both the bundle path AND the family detection see them. An empty
  // list exercises the self-location ($0) fallback (no *_PLUGIN_ROOT set).
  function runStopEchoingHost(exportFamilies: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-plugin-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "dist", "siltpoke-stop.js"),
      `console.log("HOST=" + (process.env.SILTPOKE_HOST ?? ""));`,
    );
    writeFileSync(join(root, "hooks", "stop.sh"), readFileSync(join(REPO, "hooks", "stop.sh"), "utf8"));
    const fakeHome = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
    mkdirSync(join(fakeHome, ".siltpoke"), { recursive: true });
    writeFileSync(join(fakeHome, ".siltpoke", "config.json"), "{}");
    const pluginEnv: Record<string, string> = {};
    for (const name of exportFamilies) pluginEnv[name] = root;
    try {
      const r = Bun.spawnSync([SHELL, join(root, "hooks", "stop.sh")], {
        env: { HOME: fakeHome, PATH: process.env.PATH ?? "", ...pluginEnv },
        stdin: new TextEncoder().encode("{}"),
      });
      return new TextDecoder().decode(r.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  test("stop.sh runtime: fork-specific family wins over claude when BOTH roots are exported", () => {
    expect(runStopEchoingHost(["QODER_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"])).toContain("HOST=qoder");
    expect(runStopEchoingHost(["CODEBUDDY_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"])).toContain("HOST=codebuddy");
  });

  test("stop.sh runtime: claude-only -> claude; none -> empty (ZERO REGRESSION)", () => {
    expect(runStopEchoingHost(["CLAUDE_PLUGIN_ROOT"])).toContain("HOST=claude");
    expect(runStopEchoingHost([])).toContain("HOST=");
  });
});
