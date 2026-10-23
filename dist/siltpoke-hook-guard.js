// @bun
// src/hooks/hook-guard.ts
import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { join as join6 } from "path";

// src/installer/last-host.ts
import { existsSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, statSync, utimesSync, writeFileSync as writeFileSync2 } from "fs";
import { isAbsolute, join as join3 } from "path";

// src/brain/brain-config.ts
var FAMILIES = ["claude", "codex", "agy", "qoder", "codebuddy"];

// src/utils/atomic-write.ts
import { writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname, basename, join } from "path";
function atomicWrite(path, data, opts) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${basename(path)}-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  renameSync(tmp, path);
}

// src/installer/paths.ts
import { join as join2, resolve } from "path";

class PathError extends Error {
}
function homeDir(env) {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home || home.length === 0) {
    throw new PathError("HOME environment variable is not set");
  }
  return home;
}
function siltpokeRoot(env = process.env) {
  const override = env.SILTPOKE_HOME;
  if (typeof override === "string" && override.length > 0) {
    return resolve(override);
  }
  return join2(homeDir(env), ".siltpoke");
}

// src/installer/last-host.ts
var HOST_BINARY = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  qoder: "qodercli",
  codebuddy: "codebuddy"
};
function lastHostPath(env) {
  return join3(siltpokeRoot(env), "last-host");
}
function readLastHost(homeDir2) {
  try {
    const lines = readFileSync(join3(homeDir2, "last-host"), "utf8").split(`
`);
    const family = (lines[0] ?? "").replace(/\r$/, "");
    if (!isFamily(family))
      return null;
    const second = (lines[1] ?? "").replace(/\r$/, "");
    return { family, commandPath: isAbsolute(second) ? second : null };
  } catch {
    return null;
  }
}
function isFamily(value) {
  return FAMILIES.includes(value);
}
function defaultWhich(bin) {
  return typeof Bun !== "undefined" ? Bun.which(bin) : null;
}
function recordLastHost(env, family, which = defaultWhich) {
  if (!isFamily(family))
    return false;
  markSeen(env, family);
  return writeLastHost(env, family, which);
}
function writeLastHost(env, family, which) {
  try {
    let commandPath = "";
    try {
      commandPath = which(HOST_BINARY[family]) ?? "";
    } catch {}
    atomicWrite(lastHostPath(env), `${family}
${commandPath}
`);
    return true;
  } catch {
    return false;
  }
}
var SEEN_DIR = "hosts-seen";
function seedSeen(homeDir2, dir) {
  const prev = readLastHost(homeDir2);
  if (prev === null)
    return;
  const file = join3(dir, prev.family);
  const at = statSync(join3(homeDir2, "last-host")).mtime;
  try {
    writeFileSync2(file, "", { flag: "wx" });
  } catch {
    return;
  }
  utimesSync(file, at, at);
}
function markSeen(env, family) {
  try {
    const homeDir2 = siltpokeRoot(env);
    const dir = join3(homeDir2, SEEN_DIR);
    if (!existsSync(dir)) {
      mkdirSync2(dir, { recursive: true });
      seedSeen(homeDir2, dir);
    }
    const file = join3(dir, family);
    const now = new Date;
    if (existsSync(file))
      utimesSync(file, now, now);
    else
      writeFileSync2(file, "");
  } catch {}
}

// src/router/router.ts
function isSiltpokeInternal(env = process.env) {
  return env.SILTPOKE_INTERNAL === "1";
}

// src/hooks/hook-guard-core.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, statSync as statSync2 } from "fs";
import { dirname as dirname2, join as join5, resolve as resolve2 } from "path";
import { fileURLToPath } from "url";

// src/installer/bun-path.ts
import { accessSync, constants, readFileSync as readFileSync2 } from "fs";
import { join as join4 } from "path";
function bunPathPointerPath(home) {
  return join4(home, ".siltpoke", "bun-path");
}
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveBunPath(home, deps = {}) {
  const lookup = deps.pathLookup ?? (() => Bun.which("bun"));
  const onPath = lookup();
  if (onPath && isExecutable(onPath))
    return onPath;
  try {
    const recorded = readFileSync2(bunPathPointerPath(home), "utf8").trim();
    if (recorded.length > 0 && isExecutable(recorded))
      return recorded;
  } catch {}
  const fallback = join4(home, ".bun", "bin", "bun");
  return isExecutable(fallback) ? fallback : null;
}

// src/hooks/hook-guard-core.ts
var GUARD_MODES = ["stop", "session-start", "codex-stop", "codex-session-start"];
var BUNDLE_FOR_MODE = {
  stop: "siltpoke-stop.js",
  "session-start": "handle-session-start.js",
  "codex-stop": "codex-stop.js",
  "codex-session-start": "handle-session-start.js"
};
function parseGuardMode(argv) {
  return GUARD_MODES.find((m) => argv.includes(m)) ?? "stop";
}
var NUDGE_TEXT = "Siltpoke installed. Run /siltpoke:siltpoke-setup to meet your pet (express or custom).";
var NUDGE_MARKER = ".setup-nudged";
function nudgeLine(text) {
  return `${JSON.stringify({ systemMessage: text })}
`;
}
function defaultGuardDir() {
  try {
    return dirname2(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
}
function defaultFileExists(path) {
  try {
    return existsSync2(path);
  } catch {
    return false;
  }
}
function defaultWriteNudgeMarker(path) {
  try {
    atomicWrite(path, "");
    return defaultFileExists(path);
  } catch {
    return false;
  }
}
function resolvePluginRoot(env, guardDir) {
  for (const key of ["CLAUDE_PLUGIN_ROOT", "QODER_PLUGIN_ROOT", "CODEBUDDY_PLUGIN_ROOT"]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0)
      return resolve2(value);
  }
  return guardDir.length > 0 ? resolve2(guardDir, "..") : null;
}
function writePluginRootPointer(env, guardDir) {
  try {
    const root = siltpokeRoot(env);
    const pluginRoot = resolvePluginRoot(env, guardDir);
    if (!pluginRoot)
      return false;
    const pointer = join5(root, "plugin-root");
    if (keepsCurrentRoot(pointer, pluginRoot))
      return false;
    atomicWrite(pointer, pluginRoot);
    return true;
  } catch {
    return false;
  }
}
function keepsCurrentRoot(pointer, candidate) {
  let current;
  try {
    current = readFileSync3(pointer, "utf8").trim();
  } catch {
    return false;
  }
  if (current === "" || current === candidate)
    return false;
  const mtimeOf = (r) => {
    try {
      return statSync2(join5(r, "dist", "siltpoke-daemon.js")).mtimeMs;
    } catch {
      return null;
    }
  };
  const held = mtimeOf(current);
  if (held === null)
    return false;
  const offered = mtimeOf(candidate);
  return offered === null || held > offered;
}
function detectHostFamily(env) {
  if (env.QODER_PLUGIN_ROOT)
    return "qoder";
  if (env.CODEBUDDY_PLUGIN_ROOT)
    return "codebuddy";
  if (env.CLAUDE_PLUGIN_ROOT)
    return "claude";
  return "";
}
function hostFamilyFor(mode, env) {
  return mode.startsWith("codex-") ? "codex" : detectHostFamily(env);
}
function nudgeFor(mode, root, fileExists, writeMarker) {
  if (mode !== "stop")
    return null;
  const marker = join5(root, NUDGE_MARKER);
  if (fileExists(marker))
    return null;
  return writeMarker(marker) ? NUDGE_TEXT : null;
}
function decide(mode, deps) {
  const env = deps.env;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const writeMarker = deps.writeNudgeMarker ?? defaultWriteNudgeMarker;
  let root;
  try {
    root = siltpokeRoot(env);
  } catch (err) {
    if (!(err instanceof PathError))
      throw err;
    return { action: "exit", reason: "no-home", nudge: null };
  }
  if (!fileExists(join5(root, "config.json"))) {
    return {
      action: "exit",
      reason: "no-config",
      nudge: nudgeFor(mode, root, fileExists, writeMarker)
    };
  }
  const resolveBun = deps.resolveBun ?? ((home) => resolveBunPath(home));
  const bun = resolveBun(root);
  if (!bun) {
    return { action: "exit", reason: "no-bun", nudge: null };
  }
  const guardDir = deps.guardDir ?? defaultGuardDir();
  const pluginRoot = resolvePluginRoot(env, guardDir);
  if (!pluginRoot)
    return { action: "exit", reason: "no-plugin-root", nudge: null };
  const bundle = join5(pluginRoot, "dist", BUNDLE_FOR_MODE[mode]);
  if (!fileExists(bundle))
    return { action: "exit", reason: "no-bundle", nudge: null };
  return { action: "run", bun, bundle, hostFamily: hostFamilyFor(mode, env) };
}
function selfTestLine(outcome) {
  if (outcome.action === "run") {
    return `siltpoke-guard ok bun=${outcome.bun} bundle=${outcome.bundle}`;
  }
  return `siltpoke-guard ${outcome.reason}`;
}

// src/hooks/hook-guard.ts
function logInternalError(err) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      where: "hook-guard",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    });
    appendFileSync(join6(siltpokeRoot(process.env), "hook-guard-errors.jsonl"), `${line}
`);
  } catch {}
}
async function readStdinBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}
function writeAndFlush(stream, text) {
  return new Promise((done) => {
    stream.write(text, () => done());
  });
}
async function runBundle(outcome, payload) {
  await new Promise((done) => {
    const child = spawn(outcome.bun, [outcome.bundle], {
      env: { ...process.env, SILTPOKE_HOST: outcome.hostFamily },
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.on("error", () => done());
    child.on("close", () => done());
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}
async function main(argv, stdin) {
  const selfTest = argv.includes("--self-test");
  const mode = parseGuardMode(argv);
  const payload = await readStdinBytes(stdin);
  const internal = isSiltpokeInternal(process.env);
  if (internal && !selfTest)
    return;
  if (mode === "session-start" && !internal)
    writePluginRootPointer(process.env, defaultGuardDir());
  if (!selfTest)
    recordLastHost(process.env, hostFamilyFor(mode, process.env));
  let outcome;
  try {
    outcome = decide(mode, internal ? { env: process.env, writeNudgeMarker: () => false } : { env: process.env });
  } catch (err) {
    logInternalError(err);
    outcome = { action: "exit", reason: "internal-error", nudge: null };
  }
  if (selfTest) {
    await writeAndFlush(process.stdout, `${selfTestLine(outcome)}
`);
    return;
  }
  if (outcome.action === "exit") {
    if (outcome.nudge)
      await writeAndFlush(process.stdout, nudgeLine(outcome.nudge));
    return;
  }
  try {
    await runBundle(outcome, payload);
  } catch {}
}
if (import.meta.main) {
  main(process.argv.slice(2), process.stdin).catch(() => {}).finally(() => process.exit(0));
}
export {
  readStdinBytes,
  main
};
