// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The delivery half. `check.ts`'s pure helpers are tested next door; what is
// asserted here is the WIRING — that the config switch reaches the decision,
// that a stale cache triggers a refresh nobody waits for, and that the session
// path never touches the network. Testing only the helpers would leave every
// one of those revertible with the suite still green.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshUpdateCache, updateNoticeForSession } from "../../src/update/session-notice";
import { cachePath } from "../../src/update/check";

/** 24h, the cache window. A literal here rather than an import: the constant is
 * internal to check.ts, and `audit:dead` was right that exporting it for a test
 * was not a reason to widen the module's surface. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CMD = "claude plugin update siltpoke";
const NOW = 1_800_000_000_000;

/** A throwaway home with a plugin manifest at version 1.2.0. */
function makeHome(opts: { config?: unknown; cache?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "siltpoke-upd-"));
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"version":"1.2.0"}');
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  if (opts.config !== undefined) {
    writeFileSync(join(home, "config.json"), JSON.stringify(opts.config));
  }
  if (opts.cache !== undefined) {
    writeFileSync(cachePath(home), JSON.stringify(opts.cache));
  }
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(home: string, startDir: string, extra: Record<string, unknown> = {}) {
  const state = updateNoticeForSession({
    home,
    startDir,
    updateCommand: CMD,
    nowMs: () => NOW,
    ...extra,
  });
  // `refreshed` mirrors what the HOOK would fire on this state, so the
  // assertions below still read as "did it schedule a check?".
  return { notice: state.notice, refreshed: state.needsRefresh ? [home] : [] };
}

describe("updateNoticeForSession", () => {
  test("a fresh cache with a newer version produces the sentence, and no refresh", () => {
    const h = makeHome({ cache: { checkedAtMs: NOW - 1000, latestVersion: "1.3.0", headline: "Windows works" } });
    try {
      const { notice, refreshed } = run(h.home, h.root);
      expect(notice).toContain("1.3.0");
      expect(notice).toContain("1.2.0");
      expect(notice).toContain("Windows works");
      expect(notice).toContain(CMD);
      expect(refreshed).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("`updateCheck: false` silences it completely — no sentence AND no refresh", () => {
    const h = makeHome({
      config: { updateCheck: { enabled: false } },
      cache: { checkedAtMs: 0, latestVersion: "9.9.9", headline: null },
    });
    try {
      const { notice, refreshed } = run(h.home, h.root);
      expect(notice).toBeNull();
      // The switch must cut the network call too, not merely hide the output.
      expect(refreshed).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

});

// Third slice of the same seam: the switch and its default, kept apart from the
// sentence-shaping tests above so neither block runs past the 50-LOC cap.
describe("updateNoticeForSession — the switch and its default", () => {
  test("default is ON — no config file at all still checks", () => {
    const h = makeHome({ cache: { checkedAtMs: NOW - 1000, latestVersion: "1.3.0", headline: null } });
    try {
      expect(run(h.home, h.root).notice).toContain("1.3.0");
    } finally {
      h.cleanup();
    }
  });

  test("an unrelated config file does not disable it", () => {
    const h = makeHome({
      config: { daemon: { enabled: true } },
      cache: { checkedAtMs: NOW - 1000, latestVersion: "1.3.0", headline: null },
    });
    try {
      expect(run(h.home, h.root).notice).toContain("1.3.0");
    } finally {
      h.cleanup();
    }
  });

  test("a stale cache refreshes in the background AND still returns today's answer", () => {
    const h = makeHome({
      cache: { checkedAtMs: NOW - CHECK_INTERVAL_MS - 1, latestVersion: "1.3.0", headline: null },
    });
    try {
      const { notice, refreshed } = run(h.home, h.root);
      expect(refreshed).toEqual([h.home]);
      // The point of the cache: the stale value is shown NOW, not awaited.
      expect(notice).toContain("1.3.0");
    } finally {
      h.cleanup();
    }
  });

  test("first install — no cache: refresh scheduled, and nothing is said today", () => {
    const h = makeHome();
    try {
      const { notice, refreshed } = run(h.home, h.root);
      expect(refreshed).toEqual([h.home]);
      expect(notice).toBeNull();
    } finally {
      h.cleanup();
    }
  });

});

// Split from the block above so neither describe callback exceeds the 50-LOC
// function cap. A real seam, not an arbitrary cut: above is what the check
// SAYS when everything is readable, below is what it does when something is
// broken — and "broken input produces silence" is the property this feature
// actually lives or dies on.
describe("updateNoticeForSession — the failure modes, all of which are silent", () => {
  test("a corrupt cache says nothing and re-checks, rather than throwing", () => {
    const h = makeHome();
    try {
      writeFileSync(cachePath(h.home), "{not json at all");
      const { notice, refreshed } = run(h.home, h.root);
      expect(notice).toBeNull();
      expect(refreshed).toEqual([h.home]);
    } finally {
      h.cleanup();
    }
  });

  test("a read that throws produces null, never an exception into SessionStart", () => {
    const h = makeHome({ cache: { checkedAtMs: NOW, latestVersion: "1.3.0", headline: null } });
    try {
      const { notice } = run(h.home, h.root, {
        readFileSyncFn: () => {
          throw new Error("EIO");
        },
      });
      expect(notice).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("no manifest anywhere — unknown installed version says nothing", () => {
    const h = makeHome({ cache: { checkedAtMs: NOW, latestVersion: "1.3.0", headline: null } });
    try {
      // Start the search somewhere with no manifest above it.
      const bare = mkdtempSync(join(tmpdir(), "siltpoke-bare-"));
      try {
        expect(run(h.home, bare).notice).toBeNull();
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("refreshUpdateCache", () => {
  test("writes the parsed release to disk", async () => {
    const h = makeHome();
    try {
      const entry = await refreshUpdateCache(h.home, {
        nowMs: () => NOW,
        fetchFn: (async () =>
          new Response(JSON.stringify({ tag_name: "v1.3.0", body: "- **Windows.** works" }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      expect(entry.latestVersion).toBe("1.3.0");
      // Asserted on DISK, not on the return value — the return value would be
      // right even if the write never happened.
      expect(existsSync(cachePath(h.home))).toBe(true);
      const onDisk = JSON.parse(readFileSync(cachePath(h.home), "utf8"));
      expect(onDisk.latestVersion).toBe("1.3.0");
      expect(onDisk.checkedAtMs).toBe(NOW);
    } finally {
      h.cleanup();
    }
  });

});

// The other half of the split, along the same seam: what the network call does
// when the network does not cooperate. Every one of these must end in "no
// version known", never in a throw and never in a guess.
describe("refreshUpdateCache — when the network does not cooperate", () => {
  test("offline: resolves, records the attempt, and reports no version", async () => {
    const h = makeHome();
    try {
      const entry = await refreshUpdateCache(h.home, {
        nowMs: () => NOW,
        fetchFn: (async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        }) as unknown as typeof fetch,
      });
      expect(entry).toEqual({ checkedAtMs: NOW, latestVersion: null, headline: null });
      // The attempt IS recorded — otherwise an offline machine re-checks on
      // every single session start.
      expect(JSON.parse(readFileSync(cachePath(h.home), "utf8")).checkedAtMs).toBe(NOW);
    } finally {
      h.cleanup();
    }
  });

  test("a rate-limited or error response is not treated as an answer", async () => {
    const h = makeHome();
    try {
      const entry = await refreshUpdateCache(h.home, {
        nowMs: () => NOW,
        fetchFn: (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch,
      });
      expect(entry.latestVersion).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("a 200 with a shape it does not recognise yields no version", async () => {
    const h = makeHome();
    try {
      const entry = await refreshUpdateCache(h.home, {
        nowMs: () => NOW,
        fetchFn: (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 200 })) as unknown as typeof fetch,
      });
      expect(entry.latestVersion).toBeNull();
    } finally {
      h.cleanup();
    }
  });

});

// The privacy claim, on its own, because it is a claim the README makes to
// users rather than an ordinary behaviour: "it sends nothing about you".
describe("refreshUpdateCache — what the request actually contains", () => {
  test("the request carries no user data — only an accept header", async () => {
    const h = makeHome();
    try {
      let seenUrl = "";
      let seenInit: RequestInit | undefined;
      await refreshUpdateCache(h.home, {
        nowMs: () => NOW,
        fetchFn: (async (url: string, init: RequestInit) => {
          seenUrl = String(url);
          seenInit = init;
          return new Response(JSON.stringify({ tag_name: "v1.3.0" }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      expect(seenUrl).toBe("https://api.github.com/repos/Siltpoke/siltpoke/releases/latest");
      expect(seenUrl).not.toContain("?");
      expect(Object.keys(seenInit?.headers ?? {})).toEqual(["accept"]);
      expect(seenInit?.body).toBeUndefined();
      expect(seenInit?.method ?? "GET").toBe("GET");
    } finally {
      h.cleanup();
    }
  });
});
