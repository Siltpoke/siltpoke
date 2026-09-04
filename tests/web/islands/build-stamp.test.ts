/**
 * Unit — buildStamp island.
 *
 * The invariant under test is a negative one: every failure path must leave the
 * footer BLANK. A stale daemon already presents as "the page looks fine", so a
 * placeholder or a default-green row would rebuild the exact failure this line
 * exists to end.
 *
 * Each case builds its own Response — a Response body is consumable once, so a
 * shared fixture would read empty from the second test onward and surface as an
 * assertion failure on empty text rather than as a broken fixture.
 */
import { describe, expect, test } from "bun:test";
import { type BuildLinePayload, makeBuildStamp } from "../../../src/web/client/islands/build-stamp";
import { tokens } from "../../../src/web/tokens/tokens";

const OK_LINE: BuildLinePayload = {
  show: true,
  state: "ok",
  text: "build 2602456 · 08-18 22:37",
  title: "fix(timeline): say why the audit blocks are empty (#607)\n/repo/dist/siltpoke-daemon.js",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Island wired to a given fetch, with the `$el` Alpine would supply. `init()`
 * is what reads the data attribute, so every case drives the real entry point
 * and then awaits the fetch it kicked off.
 */
function island(fetchFn: typeof fetch, url = "/api/version") {
  const data = makeBuildStamp(fetchFn);
  const bound = data as unknown as { $el?: { dataset: Record<string, string> } };
  bound.$el = { dataset: url ? { buildUrl: url } : {} };
  return data;
}

/** Run the island's real init path and settle the fetch it starts. */
async function boot(data: ReturnType<typeof island>): Promise<void> {
  data.init();
  await data.fetchBuild();
}

describe("buildStamp — happy path", () => {
  test("renders the line the server derived, verbatim", async () => {
    const data = island((async () => jsonResponse({ line: OK_LINE })) as unknown as typeof fetch);
    await boot(data);
    expect(data.ready).toBe(true);
    expect(data.line.text).toBe("build 2602456 · 08-18 22:37");
    expect(data.line.title).toContain("/repo/dist/siltpoke-daemon.js");
  });

  test("warn tier is amber; ok tier stays ambient", async () => {
    const warn = island(
      (async () =>
        jsonResponse({
          line: { ...OK_LINE, state: "warn", text: "build 2602456 · dist 已重建，重启 daemon" },
        })) as unknown as typeof fetch,
    );
    await boot(warn);
    expect(warn.tone()).toBe(tokens.color.amber);

    const ok = island((async () => jsonResponse({ line: OK_LINE })) as unknown as typeof fetch);
    await boot(ok);
    expect(ok.tone()).toBe(tokens.color.ink3);
  });
});

describe("buildStamp — every failure path stays blank, never reassuring", () => {
  test("non-2xx → blank", async () => {
    const data = island((async () => jsonResponse({ line: OK_LINE }, 500)) as unknown as typeof fetch);
    await boot(data);
    expect(data.ready).toBe(false);
    expect(data.line.text).toBe("");
  });

  test("fetch throws → blank, no unhandled rejection", async () => {
    const data = island((() => Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    await boot(data);
    expect(data.ready).toBe(false);
    expect(data.line.text).toBe("");
  });

  test("malformed body → blank", async () => {
    const data = island((async () => new Response("not json", { status: 200 })) as unknown as typeof fetch);
    await boot(data);
    expect(data.ready).toBe(false);
  });

  test("server says show:false → blank, not a rendered empty row", async () => {
    const data = island(
      (async () =>
        jsonResponse({ line: { show: false, state: "unknown", text: "", title: "" } })) as unknown as typeof fetch,
    );
    await boot(data);
    expect(data.ready).toBe(false);
  });

  test("show:true but empty text → blank, not a naked separator", async () => {
    const data = island(
      (async () => jsonResponse({ line: { ...OK_LINE, text: "" } })) as unknown as typeof fetch,
    );
    await boot(data);
    expect(data.ready).toBe(false);
  });

  test("missing data-build-url → no fetch attempted at all", async () => {
    let called = 0;
    const data = island(
      (async () => {
        called += 1;
        return jsonResponse({ line: OK_LINE });
      }) as unknown as typeof fetch,
      "",
    );
    await boot(data);
    expect(called).toBe(0);
    expect(data.ready).toBe(false);
  });
});
