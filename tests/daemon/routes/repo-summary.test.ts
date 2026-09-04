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
import { Hono } from "hono";
import { mountRepoSummaryRoute, type SummaryBrainCall } from "../../../src/daemon/routes/repo-summary";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";
import { repoSummaryPath } from "../../../src/repo-graph/repo-summary-gen";

const SECRET = "test-secret";
const ROOT = "/code/demo";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-sumroute-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeArchModel(): void {
  const dir = join(home, "repo-memory", computeProjHash(ROOT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "arch-model.json"),
    JSON.stringify({
      boundary: { value: "demo" },
      bands: [{ label: { value: "Core" } }],
      nodes: [{ title: { value: "Daemon" }, desc: { value: "the server" } }],
    }),
  );
}

const fakeBrain: SummaryBrainCall = async () => ({
  output: { summary: "A demo app that does demo things." },
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0.0012,
  },
});

function makeApp(callBrain: SummaryBrainCall = fakeBrain): Hono {
  const app = new Hono();
  mountRepoSummaryRoute(app, { home, secret: SECRET, callBrain });
  return app;
}

async function post(app: Hono, body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Siltpoke-Secret"] = secret;
  return app.request("/api/repo-summary", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/repo-summary", () => {
  test("401 without a valid secret", async () => {
    const res = await post(makeApp(), { project_root: ROOT }, "wrong");
    expect(res.status).toBe(401);
  });

  test("400 when project_root is missing", async () => {
    const res = await post(makeApp(), {});
    expect(res.status).toBe(400);
  });

  test("400 when the repo has no arch-model", async () => {
    const res = await post(makeApp(), { project_root: ROOT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("architecture model");
  });

  test("generates + caches the blurb and ledgers the cost", async () => {
    writeArchModel();
    const res = await post(makeApp(), { project_root: ROOT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary_text).toBe("A demo app that does demo things.");
    expect(body.cached).toBe(false);

    // cache written — model is now the resolved extract-role model
    // (single-brain S2: pinned snapshot, not the undated alias the old
    // static SUMMARY_MODEL sent — same weights today, different string).
    const cache = JSON.parse(readFileSync(repoSummaryPath(home, ROOT), "utf8"));
    expect(cache.text).toBe("A demo app that does demo things.");
    expect(cache.model).toBe("claude-haiku-4-5-20251001");

    // usage ledgered
    const events = readFileSync(join(home, "usage-events.jsonl"), "utf8").trim().split("\n");
    const evt = JSON.parse(events[events.length - 1]);
    expect(evt.kind).toBe("repo_summary");
    expect(evt.total_cost_usd).toBe(0.0012);
  });

  test("is idempotent — a second call returns the cache for $0 without a Brain call", async () => {
    writeArchModel();
    await post(makeApp(), { project_root: ROOT }); // first: generates

    let brainCalls = 0;
    const countingBrain: SummaryBrainCall = async (o) => {
      brainCalls++;
      return fakeBrain(o);
    };
    const res = await post(makeApp(countingBrain), { project_root: ROOT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.cost_usd).toBe(0);
    expect(brainCalls).toBe(0); // no spend on the cached path
  });

  test("429 when the budget/quiet-hours gate blocks — no spend", async () => {
    writeArchModel();
    // All-day quiet hours → the gate blocks every call.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } }),
    );
    let brainCalls = 0;
    const app = new Hono();
    mountRepoSummaryRoute(app, {
      home,
      secret: SECRET,
      callBrain: async (o) => {
        brainCalls++;
        return fakeBrain(o);
      },
      now: () => new Date("2026-06-28T12:00:00Z"),
    });
    const res = await app.request("/api/repo-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
      body: JSON.stringify({ project_root: ROOT }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).blocked).toBe("quiet_hours");
    expect(brainCalls).toBe(0); // gated before any paid call
  });

  test("502 when the Brain call fails, and nothing is cached", async () => {
    writeArchModel();
    const throwingBrain: SummaryBrainCall = async () => {
      throw new Error("boom");
    };
    const res = await post(makeApp(throwingBrain), { project_root: ROOT });
    expect(res.status).toBe(502);
    expect(existsSync(repoSummaryPath(home, ROOT))).toBe(false);
  });
});

describe("POST /api/repo-summary default seam (role-routed, single-brain S2)", () => {
  test("no deps.callBrain + home config selecting qoder for extract → real qoder path is exercised", async () => {
    writeArchModel();
    const bin = mkdtempSync(join(tmpdir(), "repo-summary-role-bin-"));
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ brain: { roles: { extract: { provider: "qoder" } } } }),
      );
      const fakeBin = join(bin, "qodercli");
      writeFileSync(
        fakeBin,
        [
          "#!/usr/bin/env bun",
          'const inner = JSON.stringify({ summary: "Routed through qoder." });',
          'const envelope = { type: "result", subtype: "success", is_error: false, result: inner, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 3 } };',
          "process.stdout.write(JSON.stringify(envelope));",
          "",
        ].join("\n"),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ""}`;

      // No `callBrain` override — exercises the real default seam.
      const app = new Hono();
      mountRepoSummaryRoute(app, { home, secret: SECRET });
      const res = await app.request("/api/repo-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
        body: JSON.stringify({ project_root: ROOT }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary_text).toBe("Routed through qoder.");

      // Cached record's model reflects the qoder-routed config (no
      // per-family default model for qoder — CLI's own account default).
      const cache = JSON.parse(readFileSync(repoSummaryPath(home, ROOT), "utf8"));
      expect(cache.model).toBe("unknown");
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
