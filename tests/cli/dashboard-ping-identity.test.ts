// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-dashboard` must not hand the user a link to somebody else's app.
 *
 * WHY — audit defect `[5b]` §26.3. `openDashboard`'s liveness probe accepted
 * any 2xx on `/api/ping` as "the daemon is up". A stranger holding the
 * dashboard port therefore made the command print that URL and open the
 * browser at the stranger's server.
 *
 * These drive the real helper against real servers — no fetch stub — so a
 * revert to `return r.ok` reds them.
 */
import { describe, expect, test } from "bun:test";
import { siltpokedAnswersAt } from "../../src/cli/dashboard";

async function against(
  fetchImpl: () => Response,
): Promise<boolean> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fetchImpl });
  try {
    return await siltpokedAnswersAt(
      `http://127.0.0.1:${server.port}/api/ping`,
      2000,
    );
  } finally {
    server.stop(true);
  }
}

describe("siltpokedAnswersAt", () => {
  test("a real siltpoked ping is accepted", async () => {
    expect(
      await against(() =>
        Response.json({ service: "siltpoked", ok: true, mode: "global", pid: 1 }),
      ),
    ).toBe(true);
  });

  test("a siltpoked from before the `service` marker is accepted", async () => {
    // Upgrade path: the daemon holding the port may predate the marker.
    expect(
      await against(() => Response.json({ ok: true, mode: "project", pid: 9 })),
    ).toBe(true);
  });

  test("an HTML catch-all server is rejected", async () => {
    expect(
      await against(() => new Response("<!doctype html><title>not siltpoke</title>")),
    ).toBe(false);
  });

  test("a foreign JSON health endpoint answering {ok:true} is rejected", async () => {
    expect(await against(() => Response.json({ ok: true }))).toBe(false);
  });

  test("a non-2xx answer is rejected", async () => {
    expect(
      await against(() => new Response("nope", { status: 503 })),
    ).toBe(false);
  });

  test("nothing listening is rejected", async () => {
    // Port 1 on loopback: nothing binds it, so this is a refused connection.
    expect(await siltpokedAnswersAt("http://127.0.0.1:1/api/ping", 500)).toBe(false);
  });
});
