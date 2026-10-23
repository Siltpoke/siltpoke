// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.4 (spec §2.3): install/bootstrap.sh leaves a one-line JSON
// note about bun for the first TS run to merge into the install receipt. Runs
// the REAL script against a sandbox HOME with stub curl / bun / bun-installer —
// nothing is downloaded, and nothing is written outside the temp dir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBootstrapFragment, readReceipt } from "../../src/installer/receipt";

const SCRIPT = join(import.meta.dir, "../../install/bootstrap.sh");
// Both: macOS's /bin/sh is bash-in-sh-mode, which forgives what Debian/Ubuntu's dash does not
// (a failed redirection on a special builtin kills a dash shell even inside `if`).
const SHELLS = ["/bin/sh", "/bin/dash"].filter((p) => existsSync(p));
let SHELL = "/bin/sh";
beforeEach(() => {
  SHELL = "/bin/sh";
});

/**
 * Run the script with NO controlling terminal: setsid() first, so /dev/tty cannot be
 * opened even when the test runner itself was started from a terminal (otherwise the
 * "no terminal" cases would find yours and prompt).
 */
const DETACH = "import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])";
function detached(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("python3", ["-c", DETACH, SHELL, SCRIPT, ...args], { env, encoding: "utf8" });
}
let root: string;
let home: string;
let stubs: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "siltpoke-bootstrap-sh-"));
  home = join(root, "home");
  stubs = join(root, "stubs");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubs, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function exe(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A tarball with a stub entry point, a `curl` that serves it (and a fake bun
 * installer that drops a `bun` into $HOME/.bun/bin), and optionally a `bun` on PATH.
 */
function setup(opts: { bunOnPath: boolean; bunInstallerFails?: boolean }): void {
  const src = join(root, "tar-src", "siltpoke");
  mkdirSync(join(src, "src", "cli"), { recursive: true });
  writeFileSync(join(src, "src", "cli", "bootstrap.ts"), "// stub");
  spawnSync("tar", ["-czf", join(root, "siltpoke.tar.gz"), "-C", join(root, "tar-src"), "siltpoke"]);
  const sha = createHash("sha256").update(readFileSync(join(root, "siltpoke.tar.gz"))).digest("hex");
  writeFileSync(join(root, "sha"), sha);
  exe(
    join(stubs, "curl"),
    `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done
case "$url" in
  *bun.sh/install*) printf '#!/bin/sh\\n%s\\n' ${opts.bunInstallerFails ? "'exit 1'" : `'mkdir -p "$HOME/.bun/bin" && printf "#!/bin/sh\\\\nexit 0\\\\n" > "$HOME/.bun/bin/bun" && chmod +x "$HOME/.bun/bin/bun"'`} > "$out";;
  *) cp "${join(root, "siltpoke.tar.gz")}" "$out";;
esac`,
  );
  if (opts.bunOnPath) exe(join(stubs, "bun"), "exit 0");
}

function runScript(args: string[] = [], extraEnv: Record<string, string> = {}): { status: number | null; fragment: string | null; stderr: string } {
  const r = detached(args, {
    HOME: home,
    PATH: `${stubs}:/usr/bin:/bin`,
    SILTPOKE_TARBALL_URL: "https://example.invalid/siltpoke.tar.gz",
    SILTPOKE_TARBALL_SHA256: readFileSync(join(root, "sha"), "utf8"),
    ...extraEnv,
  });
  const frag = join(home, ".siltpoke", "receipt-bootstrap.json");
  return { status: r.status, fragment: existsSync(frag) ? readFileSync(frag, "utf8").trim() : null, stderr: r.stderr };
}

describe.each(SHELLS)("bootstrap.sh → receipt fragment [%s]", (sh) => {
  beforeEach(() => {
    SHELL = sh;
  });

  test("bun already on PATH → fragment says not ours, done; merged entry byUs false", () => {
    setup({ bunOnPath: true });
    const r = runScript();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.fragment ?? "null")).toEqual({ id: "tool:bun", byUs: false, state: "done" });
    mergeBootstrapFragment({ HOME: home });
    expect(readReceipt({ HOME: home })?.entries.find((e) => e.id === "tool:bun")).toMatchObject({ byUs: false, state: "done" });
  });

  test("bun absent → the script installs it; fragment says ours, done; merged entry byUs true", () => {
    setup({ bunOnPath: false });
    const r = runScript(["--yes"]); // no terminal in a test: --yes is the consent
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
    expect(JSON.parse(r.fragment ?? "null")).toEqual({ id: "tool:bun", byUs: true, state: "done" });
    mergeBootstrapFragment({ HOME: home });
    expect(readReceipt({ HOME: home })?.entries.find((e) => e.id === "tool:bun")).toMatchObject({ byUs: true, state: "done" });
  });

  test("bun absent and its installer fails → the note is left as pending, never done", () => {
    setup({ bunOnPath: false, bunInstallerFails: true });
    const r = runScript(["--yes"]);
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.fragment ?? "null")).toEqual({ id: "tool:bun", byUs: true, state: "pending" });
  });

  test("a pending note from a failed earlier run is not overwritten by a re-run that now finds bun", () => {
    setup({ bunOnPath: true });
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), '{"id":"tool:bun","byUs":true,"state":"pending"}\n');
    const r = runScript();
    expect(JSON.parse(r.fragment ?? "null")).toEqual({ id: "tool:bun", byUs: true, state: "pending" });
  });

  test("SILTPOKE_HOME relocates the note together with the app dir", () => {
    setup({ bunOnPath: true });
    const elsewhere = join(root, "elsewhere");
    const r = detached([], {
      HOME: home,
      SILTPOKE_HOME: elsewhere,
      PATH: `${stubs}:/usr/bin:/bin`,
      SILTPOKE_TARBALL_URL: "https://example.invalid/siltpoke.tar.gz",
      SILTPOKE_TARBALL_SHA256: readFileSync(join(root, "sha"), "utf8"),
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(elsewhere, "receipt-bootstrap.json"))).toBe(true);
    expect(existsSync(join(home, ".siltpoke", "receipt-bootstrap.json"))).toBe(false);
  });
});

// ---- [63] P1.6: ask before installing bun --------------------------------------------------

/**
 * Run the script with a real controlling terminal (a pty), type `answer` at the
 * "[Y/n]" prompt. python3's pty module is the stand-in for a person at a terminal.
 */
const PTY = `
import os, pty, select, sys
answer, script, shell = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(shell, [shell, script], os.environ)
buf, sent = b"", False
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    buf += data
    if not sent and b"[Y/n]" in buf:
        os.write(fd, (answer + "\\n").encode())
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(buf.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;

function runOnTerminal(answer: string): { status: number | null; out: string } {
  const r = spawnSync("python3", ["-c", PTY, answer, SCRIPT, SHELL], {
    env: {
      HOME: home,
      PATH: `${stubs}:/usr/bin:/bin`,
      SILTPOKE_TARBALL_URL: "https://example.invalid/siltpoke.tar.gz",
      SILTPOKE_TARBALL_SHA256: readFileSync(join(root, "sha"), "utf8"),
    },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout };
}

describe.each(SHELLS)("bootstrap.sh asks before installing Bun ([63], spec §2.4) [%s]", (sh) => {
  beforeEach(() => {
    SHELL = sh;
  });

  test("no terminal and no --yes: Bun is NOT installed, no note, the exit says how", () => {
    setup({ bunOnPath: false });
    const r = runScript();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(false);
    expect(r.fragment).toBeNull();
    expect(r.stderr).toMatch(/no terminal/i);
    expect(r.stderr).toContain("https://bun.sh");
  });

  test("--yes: installed without a question", () => {
    setup({ bunOnPath: false });
    const r = runScript(["--yes"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
  });

  test("SILTPOKE_YES=1 counts as --yes, like the TS side (round 2); any other value does not", () => {
    setup({ bunOnPath: false });
    const yes = runScript([], { SILTPOKE_YES: "1" });
    expect(yes.status).toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
  });

  test("SILTPOKE_YES=0 or empty is not consent", () => {
    setup({ bunOnPath: false });
    for (const v of ["0", ""]) {
      expect(runScript([], { SILTPOKE_YES: v }).status).not.toBe(0);
      expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(false);
    }
  });

  test("bun already present: never asked", () => {
    setup({ bunOnPath: true });
    expect(runScript().status).toBe(0);
  });

  test("on a terminal: n → nothing installed, nothing noted, exit 1", () => {
    setup({ bunOnPath: false });
    const r = runOnTerminal("n");
    expect(r.out).toContain("Install it now? [Y/n]");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(false);
    expect(existsSync(join(home, ".siltpoke", "receipt-bootstrap.json"))).toBe(false);
  });

  test("on a terminal: y → installed and noted as ours", () => {
    setup({ bunOnPath: false });
    const r = runOnTerminal("y");
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
    expect(readFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), "utf8")).toContain('"byUs":true');
  });

  test("on a terminal: Enter takes the default, which is yes (today's behaviour)", () => {
    setup({ bunOnPath: false });
    expect(runOnTerminal("").status).toBe(0);
    expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
  });
});
