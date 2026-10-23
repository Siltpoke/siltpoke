// @bun
// src/hooks/agy-stop.ts
import { basename as basename2, dirname as dirname4, join as join10 } from "path";
import { fileURLToPath } from "url";

// src/hooks/agy-setup-hint.ts
import { existsSync, lstatSync, readFileSync, statSync } from "fs";
import { isAbsolute, join as join3 } from "path";

// src/installer/paths.ts
import { join, resolve } from "path";

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
  return join(homeDir(env), ".siltpoke");
}
function resolveAntigravityHome(env = process.env) {
  const override = env.ANTIGRAVITY_HOME ?? env.GEMINI_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".gemini", "antigravity-cli");
}
function resolveAgyPluginRoot(env = process.env) {
  const override = env.ANTIGRAVITY_HOOKS_HOME;
  const configDir = typeof override === "string" && override.length > 0 ? override : join(homeDir(env), ".gemini", "config");
  return join(configDir, "plugins", "siltpoke");
}

// src/utils/atomic-write.ts
import { writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname, basename, join as join2 } from "path";
function atomicWrite(path, data, opts) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join2(dir, `.tmp-${basename(path)}-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  renameSync(tmp, path);
}

// src/hooks/agy-setup-hint.ts
var AGY_HINT_TEXT = 'siltpoke: installed. Ask your agent to "set up Siltpoke" to meet your pet';
var MARKER = ".agy-setup-hint";
function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function hintCommand(pluginRoot, configPath) {
  return `cat >/dev/null; [ -d ${shQuote(pluginRoot)} ] && [ ! -f ${shQuote(configPath)} ] && printf '%s' ${shQuote(AGY_HINT_TEXT)}; true`;
}
function readSettings(path) {
  if (!existsSync(path))
    return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function ensureSetupHint(env, pluginRoot) {
  if (!isAbsolute(pluginRoot))
    return;
  const root = siltpokeRoot(env);
  const marker = join3(root, MARKER);
  if (existsSync(marker))
    return;
  const settingsPath = join3(resolveAntigravityHome(env), "settings.json");
  if (isSymlink(settingsPath)) {
    markOffered(marker);
    return;
  }
  const settings = readSettings(settingsPath);
  if (settings === null)
    return;
  if (!("statusLine" in settings)) {
    const next = { ...settings, statusLine: { type: "command", command: hintCommand(pluginRoot, join3(root, "config.json")) } };
    const mode = existsSync(settingsPath) ? statSync(settingsPath).mode & 511 : undefined;
    atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}
`, mode === undefined ? undefined : { mode });
    const after = readSettings(settingsPath);
    if (after === null || !("statusLine" in after))
      return;
  }
  markOffered(marker);
}
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function markOffered(marker) {
  try {
    atomicWrite(marker, "");
  } catch {}
}
function runSetupHintCli(argv, env) {
  const at = argv.indexOf("--setup-hint");
  try {
    ensureSetupHint(env, at >= 0 ? argv[at + 1] ?? "" : "");
  } catch {}
}

// src/hooks/agy-wire-pet.ts
import { join as join7 } from "path";

// src/installer/agy-statusline.ts
import { existsSync as existsSync4, statSync as statSync2 } from "fs";
import { join as join6 } from "path";

// src/installer/receipt.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, renameSync as renameSync2, rmSync } from "fs";
import { homedir } from "os";
import { join as join5 } from "path";

// src/installer/created-paths.ts
import { lstatSync as lstatSync2 } from "fs";
import { dirname as dirname2, resolve as resolve2, sep } from "path";
var FILE_KINDS = new Set(["host-hook", "statusline"]);
var PATH_KINDS = new Set(["host-hook", "statusline", "file", "launch-agent"]);
function missing(path) {
  try {
    lstatSync2(path);
    return false;
  } catch (e) {
    return e.code === "ENOENT";
  }
}
function newlyCreated(target, kind, home) {
  if (!PATH_KINDS.has(kind))
    return [];
  const root = resolve2(home);
  const file = resolve2(target);
  if (!file.startsWith(root + sep))
    return [];
  const out = [];
  for (let dir = dirname2(file);dir.startsWith(root + sep) && missing(dir); dir = dirname2(dir))
    out.push(dir);
  if (FILE_KINDS.has(kind) && missing(file))
    out.push(file);
  return out;
}

// src/installer/installed-version.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { dirname as dirname3, join as join4, parse } from "path";
function findInstalledVersion(startDir) {
  let dir = startDir;
  const root = parse(dir).root;
  for (;; ) {
    for (const rel of [join4(".claude-plugin", "plugin.json"), "package.json"]) {
      const candidate = join4(dir, rel);
      if (existsSync2(candidate)) {
        const v = readVersionField(candidate);
        if (v)
          return v;
      }
    }
    if (dir === root)
      return null;
    const parent = dirname3(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function readVersionField(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

// src/installer/receipt.ts
var KINDS = [
  "statusline",
  "host-hook",
  "launch-agent",
  "macos-pref",
  "file",
  "outside-tool",
  "user-data"
];
function receiptPath(env = process.env) {
  return join5(siltpokeRoot(env), "receipt.json");
}
function readReceipt(env = process.env) {
  const path = receiptPath(env);
  if (!existsSync3(path))
    return null;
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    return isReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function recordBefore(entry, env = process.env, opts = {}) {
  const receipt = loadForWrite(env);
  const prior = receipt.entries.find((e) => e.id === entry.id);
  const next = {
    ...entry,
    byUs: prior?.state === "done" ? prior.byUs : entry.byUs,
    state: "pending",
    at: (opts.now ?? new Date).toISOString(),
    siltpokeVersion: opts.version !== undefined ? opts.version : findInstalledVersion(import.meta.dir)
  };
  const entries = prior ? receipt.entries.map((e) => e.id === entry.id ? next : e) : [...receipt.entries, next];
  const created = withCreated(receipt.created, entry, env);
  save(env, { ...receipt, entries, ...created ? { created } : {} });
}
function withCreated(prior, entry, env) {
  let fresh = [];
  try {
    fresh = newlyCreated(entry.target, entry.kind, homeDir(env));
  } catch {}
  if (fresh.length === 0)
    return prior;
  return [...prior ?? [], ...fresh.filter((p) => !prior?.includes(p))];
}
function markDone(id, env = process.env) {
  const receipt = readReceipt(env);
  if (!receipt?.entries.some((e) => e.id === id))
    return false;
  save(env, {
    ...receipt,
    entries: receipt.entries.map((e) => e.id === id ? { ...e, state: "done" } : e)
  });
  return true;
}
function loadForWrite(env) {
  const path = writablePath(env);
  const existing = readReceipt(env);
  if (existing)
    return existing;
  if (existsSync3(path)) {
    try {
      renameSync2(path, `${path}.corrupt-${Date.now()}`);
    } catch {}
  }
  return { version: 1, entries: [], projects: [] };
}
function save(env, receipt) {
  atomicWrite(writablePath(env), `${JSON.stringify(receipt, null, 2)}
`);
}
function writablePath(env) {
  const path = receiptPath(env);
  const realDefault = receiptPath({ HOME: process.env.HOME ?? homedir() });
  if (false) {}
  return path;
}
function isReceipt(v) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return false;
  const r = v;
  return r.version === 1 && Array.isArray(r.entries) && r.entries.every(isEntry) && Array.isArray(r.projects) && r.projects.every((p) => typeof p === "string") && (r.created === undefined || Array.isArray(r.created) && r.created.every((p) => typeof p === "string"));
}
function isEntry(v) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return false;
  const e = v;
  return typeof e.id === "string" && typeof e.kind === "string" && KINDS.includes(e.kind) && typeof e.target === "string" && typeof e.byUs === "boolean" && (e.state === "pending" || e.state === "done") && typeof e.at === "string" && (e.siltpokeVersion === null || typeof e.siltpokeVersion === "string") && (e.level === "uninstall" || e.level === "purge") && !!e.undo && typeof e.undo === "object" && !Array.isArray(e.undo);
}

// src/installer/receipt-sites.ts
function agyStatuslineEntry(settingsPath) {
  return {
    id: "statusline:antigravity",
    kind: "statusline",
    target: settingsPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "unwire-agy-statusline" }
  };
}

// src/installer/agy-statusline.ts
var AGY_NO_BUN_TEXT = "siltpoke: can't find bun (not on PATH)";
function agyPetCommand(bunPath, card) {
  return [
    `B=${shQuote(bunPath)}`,
    `[ -f "$B" ] && [ -x "$B" ] || B="$(command -v bun 2>/dev/null)"`,
    `[ -n "$B" ] || B="$(cat "$HOME/.siltpoke/bun-path" 2>/dev/null)"`,
    `[ -f "$B" ] && [ -x "$B" ] || B="$HOME/.bun/bin/bun"`,
    `if [ -x "$B" ]; then "$B" ${shQuote(card)} --agent antigravity 2>/dev/null; else cat >/dev/null; printf '%s' ${shQuote(AGY_NO_BUN_TEXT)}; fi`,
    "true"
  ].join("; ");
}
var QUOTED = /'[^']*'(?:\\''[^']*')*/g;
function shape(command) {
  return command.replace(QUOTED, "Q");
}
var SOURCE_PET = /^.+ .+[/\\]src[/\\]face[/\\]wrapper\.ts --agent antigravity$/;
function isOurAgyStatusLine(command) {
  if (typeof command !== "string")
    return false;
  if (shape(command) === shape(hintCommand("a", "b")))
    return true;
  if (shape(command) === shape(agyPetCommand("a", "b"))) {
    const card = command.match(QUOTED)?.[1] ?? "";
    return card.replace(/\\/g, "/").endsWith("/dist/siltpoke-card.js'");
  }
  return SOURCE_PET.test(command);
}
function wireAgyStatusline(env, bunPath, pluginRoot = resolveAgyPluginRoot(env)) {
  const card = join6(pluginRoot, "dist", "siltpoke-card.js");
  if (!existsSync4(card))
    return "no-agy";
  const settingsPath = join6(resolveAntigravityHome(env), "settings.json");
  if (isSymlink(settingsPath))
    return "unwritable";
  const settings = readSettings(settingsPath);
  if (settings === null)
    return "unwritable";
  const current = settings.statusLine;
  if (current !== undefined && !isOurAgyStatusLine(current?.command))
    return "occupied";
  const command = agyPetCommand(bunPath, card);
  const entry = agyStatuslineEntry(settingsPath);
  recordBefore(entry, env);
  if (current?.command === command) {
    markDone(entry.id, env);
    return "installed";
  }
  const next = { ...settings, statusLine: { type: "command", command } };
  const mode = existsSync4(settingsPath) ? statSync2(settingsPath).mode & 511 : undefined;
  atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}
`, mode === undefined ? undefined : { mode });
  const after = readSettings(settingsPath);
  const written = after?.statusLine?.command;
  if (written !== command)
    return "unwritable";
  markDone(entry.id, env);
  return "installed";
}

// src/hooks/agy-wire-pet.ts
var WIRED_MARKER = ".agy-pet-wired";
function ensurePetWired(env, pluginRoot) {
  if (!pluginRoot)
    return;
  const marker = join7(siltpokeRoot(env), WIRED_MARKER);
  const done = () => {
    try {
      atomicWrite(marker, "");
    } catch {}
  };
  const linked = isSymlink(join7(resolveAntigravityHome(env), "settings.json"));
  if (linked) {
    done();
    return;
  }
  const outcome = wireAgyStatusline(env, process.execPath, pluginRoot);
  if (outcome !== "unwritable" && outcome !== "no-agy")
    done();
}
function runWirePetCli(argv, env) {
  const at = argv.indexOf("--wire-pet");
  try {
    ensurePetWired(env, at >= 0 ? argv[at + 1] ?? "" : "");
  } catch {}
}

// src/critic/spawn.ts
async function spawnWithTimeout(opts) {
  const { argv, cwd, env, timeoutMs, stdin } = opts;
  let proc;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      cwd,
      env: env !== undefined ? env : undefined
    });
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false
    };
  }
  let timer;
  const timeoutPromise = new Promise((resolve3) => {
    timer = setTimeout(() => {
      try {
        proc?.kill();
      } catch {}
      proc?.exited.catch(() => {});
      resolve3({ kind: "timeout" });
    }, timeoutMs);
  });
  let raceResult;
  try {
    raceResult = await Promise.race([
      proc.exited.then((code) => ({ kind: "exited", code: typeof code === "number" ? code : null })),
      timeoutPromise
    ]);
  } catch {
    raceResult = { kind: "exited", code: null };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  let stdout = "";
  let stderr = "";
  const outStream = proc.stdout;
  const errStream = proc.stderr;
  if (outStream instanceof ReadableStream) {
    try {
      stdout = await new Response(outStream).text();
    } catch {}
  }
  if (errStream instanceof ReadableStream) {
    try {
      stderr = await new Response(errStream).text();
    } catch {}
  }
  if (raceResult.kind === "timeout") {
    return { exitCode: null, stdout, stderr, timedOut: true };
  }
  return {
    exitCode: raceResult.code,
    stdout,
    stderr,
    timedOut: false
  };
}

// src/repo-graph/why-index.ts
import { randomBytes } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join as join8 } from "path";
var GIT_TIMEOUT_MS = 5000;
function storePath(cwd) {
  return join8(cwd, ".siltpoke", "why-index.json");
}
async function atomicWriteIndex(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}
async function readWhyIndex(cwd) {
  try {
    const parsed = JSON.parse(await readFile(storePath(cwd), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
var defaultRunGit = async (argv, cwd) => {
  const r = await spawnWithTimeout({ argv: ["git", ...argv], cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};
async function recordSessionCommits(input) {
  const runGit = input.runGit ?? defaultRunGit;
  const argv = ["log", "--no-merges", "--format=%H %cI", `${input.baselineSha}..${input.headSha}`];
  const { exitCode, stdout } = await runGit(argv, input.cwd);
  if (exitCode !== 0)
    return;
  const lo = Date.parse(input.capturedAt);
  const hi = Date.parse(input.stopTime);
  const idx = await readWhyIndex(input.cwd);
  for (const line of stdout.split(`
`)) {
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (!m)
      continue;
    const sha = m[1];
    const t = Date.parse(m[2]);
    if (Number.isNaN(t) || t < lo || t > hi)
      continue;
    const entry = idx[sha] ?? { sessions: [] };
    if (!entry.sessions.some((s) => s.session_id === input.sessionId)) {
      entry.sessions.push({ session_id: input.sessionId, transcript_path: input.transcriptPath, host: input.host, recorded_at: input.stopTime });
    }
    idx[sha] = entry;
  }
  await mkdir(join8(input.cwd, ".siltpoke"), { recursive: true });
  await atomicWriteIndex(storePath(input.cwd), idx);
}

// src/hooks/session-baseline.ts
import { createHash } from "crypto";
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "fs";
import { join as join9 } from "path";
var SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isSafeSessionId(sessionId) {
  return SAFE_SESSION_ID.test(sessionId);
}
function stateDirFor(cwd) {
  return join9(cwd, ".siltpoke");
}
function legacyBaselinePath(stateDir) {
  return join9(stateDir, "baseline.json");
}
function sessionBaselineDir(stateDir) {
  return join9(stateDir, "baselines");
}
function idDigest(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}
function sessionBaselinePath(stateDir, sessionId) {
  if (!isSafeSessionId(sessionId))
    return null;
  return join9(sessionBaselineDir(stateDir), `${sessionId}-${idDigest(sessionId)}.json`);
}
function readSessionBaseline(cwd, sessionId) {
  const stateDir = stateDirFor(cwd);
  const perSession = sessionBaselinePath(stateDir, sessionId);
  if (perSession !== null) {
    const hit = parseBaselineFile(perSession, sessionId);
    if (hit !== null)
      return hit;
  }
  return parseBaselineFile(legacyBaselinePath(stateDir), sessionId);
}
function parseBaselineFile(file, sessionId) {
  if (!existsSync5(file))
    return null;
  try {
    const persisted = JSON.parse(readFileSync4(file, "utf8"));
    if (typeof persisted.head_sha !== "string")
      return null;
    if (typeof persisted.captured_at !== "string")
      return null;
    if (persisted.session_id !== sessionId)
      return null;
    const resolved = {
      head_sha: persisted.head_sha,
      session_id: sessionId,
      captured_at: persisted.captured_at
    };
    if (persisted.late_capture !== undefined)
      resolved.late_capture = true;
    return resolved;
  } catch {
    return null;
  }
}

// src/hooks/why-index-wiring.ts
var defaultRevParse = async (cwd) => {
  const r = await spawnWithTimeout({ argv: ["git", "rev-parse", "HEAD"], cwd, timeoutMs: 5000 });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};
async function maybeRecordWhy(input) {
  try {
    const b = readSessionBaseline(input.cwd, input.sessionId);
    if (b === null)
      return;
    if (b.late_capture)
      return;
    const head = await (input.runRevParse ?? defaultRevParse)(input.cwd);
    if (head.exitCode !== 0)
      return;
    const headSha = head.stdout.trim();
    if (!headSha || headSha === b.head_sha)
      return;
    await recordSessionCommits({
      cwd: input.cwd,
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      host: input.host,
      baselineSha: b.head_sha,
      capturedAt: b.captured_at,
      headSha,
      stopTime: input.stopTime,
      runGit: input.runGit
    });
  } catch {}
}

// src/hooks/agy-stop.ts
async function readStdinAll() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function resolveOnStopTarget(hereDir) {
  if (basename2(hereDir) === "dist") {
    return join10(hereDir, "siltpoke-stop.js");
  }
  return join10(hereDir, "on-stop.ts");
}
function normalizeAgyStop(raw) {
  let input = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input = parsed;
    }
  } catch {
    input = {};
  }
  const transcriptPath = typeof input.transcriptPath === "string" ? input.transcriptPath : undefined;
  const sessionId = typeof input.conversationId === "string" ? input.conversationId : "antigravity";
  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const cwd = typeof workspacePaths[0] === "string" ? workspacePaths[0] : process.cwd();
  const stopEventTimestampMs = typeof input.executionNum === "number" ? input.executionNum : undefined;
  return JSON.stringify({
    ...input,
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    siltpoke_host: "antigravity",
    stop_event_timestamp_ms: stopEventTimestampMs
  });
}
function dispatchAgyReview(normalizedJson, onStopTarget, env, spawnFn) {
  try {
    const spawn = spawnFn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
    const proc = spawn([process.execPath, onStopTarget], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      env: { ...env, SILTPOKE_SUPPRESSION_ENABLED: env.SILTPOKE_SUPPRESSION_ENABLED ?? "1" }
    });
    if (proc.stdin) {
      proc.stdin.write(normalizedJson);
      proc.stdin.end();
    }
    proc.unref();
  } catch {}
}
async function runAgyStopHook(opts) {
  const env = opts.env ?? process.env;
  const normalized = normalizeAgyStop(opts.rawJson);
  if (env.SILTPOKE_INTERNAL === "1") {
    return { normalized };
  }
  try {
    const parsed = JSON.parse(normalized);
    if (parsed.cwd && parsed.session_id && parsed.transcript_path) {
      maybeRecordWhy({
        cwd: parsed.cwd,
        sessionId: parsed.session_id,
        transcriptPath: parsed.transcript_path,
        host: "antigravity",
        stopTime: new Date().toISOString()
      }).catch(() => {});
    }
  } catch {}
  const hereDir = opts.hereDir ?? dirname4(fileURLToPath(import.meta.url));
  const onStopTarget = resolveOnStopTarget(hereDir);
  dispatchAgyReview(normalized, onStopTarget, env, opts.spawnFn);
  return { normalized };
}
function writeStopResponse(out = process.stdout) {
  out.write("{}");
}
if (import.meta.main && process.argv.includes("--wire-pet")) {
  runWirePetCli(process.argv, process.env);
  process.exit(0);
}
if (import.meta.main && process.argv.includes("--setup-hint")) {
  runSetupHintCli(process.argv, process.env);
  process.exit(0);
}
if (import.meta.main) {
  try {
    const raw = await readStdinAll();
    await runAgyStopHook({ rawJson: raw });
  } catch {} finally {
    writeStopResponse();
    process.exit(0);
  }
}
export {
  writeStopResponse,
  runAgyStopHook,
  resolveOnStopTarget,
  normalizeAgyStop
};
