/**
 * Unit — GET /api/version carries a MEASURED build identity.
 *
 * The endpoint's whole value is that its build fields cannot be satisfied by
 * reading the checkout, so the tests here pin the two things that would make it
 * useless again: the hand-maintained `daemonVersion` must stay separate from
 * the measured stamp, and a capture failure must degrade rather than 500 (this
 * is the surface a reader opens when something is already wrong).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { BuildStamp } from "../../src/build-stamp/format";
import { mountVersionRoute } from "../../src/daemon/routes/version";

const STAMP: BuildStamp = {
  bundlePath: "/repo/dist/siltpoke-daemon.js",
  bootSha256: "aaaa",
  diskSha256: "aaaa",
  commit: "260245637da33b9b5d1f585fd1bcfd51db1f06ce",
  commitTime: "2026-08-18T22:37:47-07:00",
  commitSubject: "fix(timeline): say why the audit blocks are empty (#607)",
  behindUpstream: 0,
  upstreamRef: "origin/main",
};

function appWith(readStamp: () => BuildStamp) {
  const app = new Hono();
  mountVersionRoute(app, { readBuildStamp: readStamp });
  return app;
}

async function getVersion(app: Hono) {
  const res = await app.request("/api/version");
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/version", () => {
  test("keeps the protocol fields its existing consumers read", async () => {
    const { status, body } = await getVersion(appWith(() => STAMP));
    expect(status).toBe(200);
    expect(body.daemonVersion).toBe("0.1.1");
    expect(body.protocol).toBe(1);
  });

  test("reports the measured stamp and the derived line together", async () => {
    const { body } = await getVersion(appWith(() => STAMP));
    expect(body.build).toEqual(STAMP as unknown as Record<string, unknown>);
    expect((body.line as { text: string }).text).toContain("2602456");
  });

  test("the protocol number is NOT the build identity", async () => {
    // Two different builds must not report the same identity just because they
    // share a hand-maintained protocol number.
    const other = { ...STAMP, commit: "b5010a2e9c0d0db9f6b42a1eb0cd4e4fc7c555c0" };
    const a = await getVersion(appWith(() => STAMP));
    const b = await getVersion(appWith(() => other));
    expect(a.body.daemonVersion).toBe(b.body.daemonVersion);
    expect((a.body.line as { text: string }).text).not.toBe(
      (b.body.line as { text: string }).text,
    );
  });

  test("a capture that throws degrades to 200 with no build claim", async () => {
    const { status, body } = await getVersion(
      appWith(() => {
        throw new Error("git exploded");
      }),
    );
    expect(status).toBe(200);
    expect(body.build).toBeNull();
    expect((body.line as { show: boolean }).show).toBe(false);
  });
});
