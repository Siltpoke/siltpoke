// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Response compression (`app.use("*", compress(...))` in `src/daemon/server.ts`).
 *
 * Measured motivation (2026-08-11): one `/knowledge` load shipped 755 KB
 * across three assets with no `Content-Encoding` at all, while the server
 * itself answered in 0.28s warm — the page was slow on assets, not on
 * documents. gzip takes that payload to ~160 KB.
 *
 * Two things need pinning, and they need pinning DIFFERENTLY:
 *
 * 1. That the middleware is actually MOUNTED — proven only by booting the
 *    real daemon (`startDaemon`) and reading a real response's headers.
 *    Every other daemon test in this directory mounts one route onto a fresh
 *    `new Hono()`, which would pass identically whether or not
 *    `server.ts` ever calls `compress()`.
 *
 * 2. That SSE is NEVER compressed. A `CompressionStream` wrapped around
 *    `text/event-stream` buffers the stream into gzip blocks, so the chat
 *    surface would stop delivering tokens incrementally — it would still
 *    "work", just arrive all at once, which is exactly the kind of failure
 *    that ships. Hono excludes SSE by construction (its
 *    `COMPRESSIBLE_CONTENT_TYPE_REGEX` carries a `text/(?!event-stream…)`
 *    negative lookahead), but "the library's regex looks right" is a code
 *    comment, not evidence, so it is asserted here against a live response.
 *
 * Both SSE cases carry a DEAD-GUARD TRAP, which is the whole reason they are
 * written the way they are. "SSE has no Content-Encoding" passes trivially
 * when compression is switched off entirely — the assertion would survive the
 * removal of the very thing it exists to constrain. So every such case
 * asserts a compressible sibling through the SAME app in the same test: if
 * compression is off, the sibling fails and the test cannot pass quietly.
 *
 * TWO REVIEW FINDINGS, kept here because this file is their best specimen —
 * the file that preaches trap-springers shipped its first draft with two
 * assertions that could not fail:
 *
 * - The wiring cases originally fetched `/static/index.js` behind an
 *   `if (res.status === 503) return;`. That reads as a graceful degrade and
 *   is anything but: `public/static/` is gitignored, `ensureClientBundle()`
 *   is skipped for `port: 0` daemons (every daemon this suite boots), and no
 *   CI step builds the bundle — so in CI, and only in CI, the route 503s
 *   deterministically and both tests returned before asserting anything.
 *   They passed locally because the developer's machine happened to have a
 *   built bundle lying around. Now they fetch `/static/tokens.css`, which its
 *   route regenerates from tracked source on demand, and there is no early
 *   return left to hide behind.
 * - The identity-encoding case asserted only that an un-negotiated response
 *   is unencoded — true with the middleware deleted, since compression never
 *   fires for a client that did not ask. It now pairs that with a gzip
 *   request for the same URL, and compares the two bodies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { type DaemonHandle, startDaemon, stopDaemon } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";

/** Not a configured threshold — there is none. Hono's `threshold` option
 *  only fires when the response carries `Content-Length`, and Hono never sets
 *  that header (measured: `c.json()`/`c.text()` both yield `content-length:
 *  null`), so `src/daemon/server.ts` deliberately passes no threshold rather
 *  than shipping a knob that cannot work. This constant is just the size used
 *  to build bodies big enough that "too small to bother" can never be an
 *  alternative explanation for a result below. */
const BIG_ENOUGH = 1024;

/** A body comfortably over the threshold that also COMPRESSES well, so an
 *  assertion about size actually has room to be wrong. Highly repetitive on
 *  purpose — mirrors the real `/knowledge` HTML, which is mostly repeated
 *  `<a href=…>` rows. */
const BIG_HTML = `<!doctype html><html><body>${"<a href='/knowledge?type=research&status=live'>row</a>".repeat(400)}</body></html>`;

describe("response compression — real daemon wiring", () => {
  let handle: DaemonHandle | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (handle) {
      try {
        await stopDaemon(handle);
      } catch {
        /* a failed boot leaves nothing to stop */
      }
    }
    handle = null;
    resetNavAvailability();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
    dir = null;
  });

  async function boot(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "compression-"));
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    return `http://127.0.0.1:${handle.server.port}`;
  }

  test("a large asset comes back gzip-encoded and decodes intact", async () => {
    const base = await boot();
    const res = await fetch(`${base}/static/tokens.css`, {
      headers: { "Accept-Encoding": "gzip" },
    });

    // NO early return on 503, and the target is `tokens.css` rather than the
    // client bundle, for one reason found in review: `/static/index.js` 503s
    // deterministically in CI, which made the original version of this test
    // silently assert NOTHING there. `public/static/` is gitignored,
    // `ensureClientBundle()` is skipped for `port: 0` daemons
    // (`src/daemon/server.ts`) — which is every daemon this suite boots — and
    // no CI step builds it. So a `if (res.status === 503) return;` guard was
    // not a graceful degrade; it was an assertion that could not fail on the
    // machine that matters most. That is the same "signal decoupled from
    // reality" shape this file's SSE cases were deliberately written to avoid,
    // sitting three tests above them.
    //
    // `tokens.css` has no such prerequisite: its route calls
    // `buildTokensCss()`, which writes the file from the tracked
    // `src/web/tokens/tokens.ts` whenever it is missing, so a 200 with a real
    // body is guaranteed on a clean checkout.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");

    // `fetch` transparently decodes, so reaching real CSS here proves the
    // gzip stream was well-formed end to end — a truncated or double-encoded
    // body would throw or come back as bytes that are not a stylesheet.
    const body = await res.text();
    expect(body.length).toBeGreaterThan(BIG_ENOUGH);
    expect(body).toContain("--color-");
  });

  test("even a tiny response is encoded — there is no size gate, by design", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/ping`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    // Well under 1 KB, and still encoded. This is the assertion that would
    // have let a `threshold: 1024` ship as a dead knob: it was written the
    // other way round first, went red, and the investigation found Hono's
    // threshold is inert without `Content-Length` (see `BIG_ENOUGH`'s doc).
    // Pinned in this direction so the real behaviour is the documented one.
    expect((await res.clone().text()).length).toBeLessThan(BIG_ENOUGH);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("a client that does not advertise gzip gets the same asset unencoded", async () => {
    const base = await boot();
    const url = `${base}/static/tokens.css`;

    const identity = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
    expect(identity.status).toBe(200);
    expect(identity.headers.get("content-encoding")).toBeNull();
    const plain = await identity.text();
    expect(plain.length).toBeGreaterThan(BIG_ENOUGH);

    // THE TRAP-SPRINGER, added in review. On its own, "identity gets no
    // Content-Encoding" passes whether or not `compress()` is mounted at all —
    // compression never fires for a client that did not ask for it, so the
    // assertion above cannot fail for the reason it exists. Asking the SAME
    // route for gzip in the SAME test is what makes this case load-bearing:
    // delete the middleware and this half goes red.
    const encoded = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
    expect(encoded.headers.get("content-encoding")).toBe("gzip");

    // And the two must be the same document — content negotiation, not two
    // different responses. A middleware that served a truncated or altered
    // body under gzip would pass both header assertions above.
    expect(await encoded.text()).toBe(plain);
  });
});

describe("response compression — SSE is never compressed", () => {
  /** An app wired with the SAME middleware call the daemon uses, plus two
   *  routes: the SSE one under test, and a compressible sibling whose job is
   *  to fail loudly if compression is not running at all (see this file's doc
   *  comment — without the sibling, every assertion below passes with the
   *  middleware deleted). */
  function appWithCompression(): Hono {
    const app = new Hono();
    app.use("*", compress());
    app.get("/sse", (c) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          // Padded past the threshold so "it was too small to compress"
          // can never be the reason this response comes back unencoded —
          // the content type has to be the reason.
          controller.enqueue(enc.encode(`data: ${"x".repeat(BIG_ENOUGH * 2)}\n\n`));
          controller.enqueue(enc.encode("data: second\n\n"));
          controller.close();
        },
      });
      return c.body(stream, 200, { "Content-Type": "text/event-stream" });
    });
    app.get("/page", (c) =>
      c.body(BIG_HTML, 200, { "Content-Type": "text/html; charset=utf-8" }),
    );
    return app;
  }

  test("an SSE response is not encoded, while a sibling HTML response is", async () => {
    const app = appWithCompression();

    const sse = await app.request("/sse", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    expect(sse.headers.get("content-encoding")).toBeNull();

    // THE TRAP-SPRINGER. Delete the `compress()` line above and this is the
    // assertion that goes red; the SSE assertion alone would not.
    const page = await app.request("/page", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(page.headers.get("content-encoding")).toBe("gzip");
  });

  test("SSE frames still arrive as separate reads, not one buffered block", async () => {
    const app = appWithCompression();
    const sse = await app.request("/sse", {
      headers: { "Accept-Encoding": "gzip" },
    });

    // The header assertion above says "not labelled as encoded". This says
    // the stream still BEHAVES like a stream: a gzip wrapper would coalesce
    // both frames into one deflate block, so counting reads is what actually
    // catches the failure the chat surface would suffer.
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(dec.decode(value, { stream: true }));
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("data: second");

    const page = await app.request("/page", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(page.headers.get("content-encoding")).toBe("gzip");
  });

  test("compression actually shrinks the payload it is applied to", async () => {
    const app = appWithCompression();
    const res = await app.request("/page", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");

    // Read the RAW encoded bytes (not `.text()`, which would decode) and
    // compare against the source. Asserting the header alone would pass on a
    // middleware that labelled a response gzip without shrinking it.
    const encoded = await res.arrayBuffer();
    expect(encoded.byteLength).toBeLessThan(BIG_HTML.length / 2);
  });
});
