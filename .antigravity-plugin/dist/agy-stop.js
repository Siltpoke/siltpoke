// @bun
// src/hooks/agy-stop.ts
import { basename, dirname, join as join3 } from "path";
import { fileURLToPath } from "url";

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
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        proc?.kill();
      } catch {}
      proc?.exited.catch(() => {});
      resolve({ kind: "timeout" });
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
import { join } from "path";
var GIT_TIMEOUT_MS = 5000;
function storePath(cwd) {
  return join(cwd, ".siltpoke", "why-index.json");
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
  await mkdir(join(input.cwd, ".siltpoke"), { recursive: true });
  await atomicWriteIndex(storePath(input.cwd), idx);
}

// src/hooks/session-baseline.ts
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join as join2 } from "path";
var SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isSafeSessionId(sessionId) {
  return SAFE_SESSION_ID.test(sessionId);
}
function stateDirFor(cwd) {
  return join2(cwd, ".siltpoke");
}
function legacyBaselinePath(stateDir) {
  return join2(stateDir, "baseline.json");
}
function sessionBaselineDir(stateDir) {
  return join2(stateDir, "baselines");
}
function idDigest(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}
function sessionBaselinePath(stateDir, sessionId) {
  if (!isSafeSessionId(sessionId))
    return null;
  return join2(sessionBaselineDir(stateDir), `${sessionId}-${idDigest(sessionId)}.json`);
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
  if (!existsSync(file))
    return null;
  try {
    const persisted = JSON.parse(readFileSync(file, "utf8"));
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
  if (basename(hereDir) === "dist") {
    return join3(hereDir, "siltpoke-stop.js");
  }
  return join3(hereDir, "on-stop.ts");
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
    const proc = spawn(["bun", onStopTarget], {
      stdio: ["pipe", "ignore", "ignore"],
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
  const hereDir = opts.hereDir ?? dirname(fileURLToPath(import.meta.url));
  const onStopTarget = resolveOnStopTarget(hereDir);
  dispatchAgyReview(normalized, onStopTarget, env, opts.spawnFn);
  return { normalized };
}
function writeStopResponse(out = process.stdout) {
  out.write("{}");
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
