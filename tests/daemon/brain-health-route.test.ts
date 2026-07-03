/**
 * API route tests — GET /api/brain-health.
 *
 * Feeds the dashboard ephemeral health strip: same predicate as the
 * state-card ⚠ line (consecutive_failures ≥ 2 OR permanent; 24h age-out;
 * auto-clear on success).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountBrainHealthRoute } from "../../src/daemon/routes/brain-health";
import {
  freshBrainHealth,
  recordFailure,
  recordSuccess,
  writeBrainHealth,
} from "../../src/state/brain-health";

let homeBase: string;
beforeEach(() => {
  homeBase = mkdtempSync(join(tmpdir(), "siltpoke-bh-route-"));
});
afterEach(() => {
  rmSync(homeBase, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountBrainHealthRoute(app, { homeBase });
  return app;
}

describe("GET /api/brain-health", () => {
  test("healthy / no record → show:false", async () => {
    const res = await buildApp().request("/api/brain-health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { show: boolean } };
    expect(json.success).toBe(true);
    expect(json.data.show).toBe(false);
  });

  test("unhealthy → show:true with classified line + health record", async () => {
    let h = freshBrainHealth();
    const ts = new Date().toISOString();
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts });
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts });
    writeBrainHealth(homeBase, h);
    const res = await buildApp().request("/api/brain-health");
    const json = (await res.json()) as {
      data: { show: boolean; line: string; consecutive_failures: number; last_failure: { class: string } | null };
    };
    expect(json.data.show).toBe(true);
    expect(json.data.line).toContain("resource");
    expect(json.data.consecutive_failures).toBe(2);
    expect(json.data.last_failure?.class).toBe("resource");
  });

  test("after success → show:false again (auto-clear, no user ack)", async () => {
    let h = freshBrainHealth();
    const ts = new Date().toISOString();
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts });
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts });
    h = recordSuccess(h, ts);
    writeBrainHealth(homeBase, h);
    const res = await buildApp().request("/api/brain-health");
    const json = (await res.json()) as { data: { show: boolean } };
    expect(json.data.show).toBe(false);
  });
});
