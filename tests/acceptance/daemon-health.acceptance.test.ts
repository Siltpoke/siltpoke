/**
 * INDEPENDENT acceptance test — daemon build-staleness reporting.
 *
 * Exercises the system FROM OUTSIDE:
 *   - mounts the real route on a fresh Hono app + `fetch`es /api/daemon-health,
 *     asserting the promised observable HTTP envelope; and
 *   - drives the pure `computeStaleness` contract that the route's behavior is
 *     defined by, for the branch-exhaustive "unknown never leaks a number" case.
 *
 * Requirements under test:
 *   - daemon captures build SHA (+ boot timestamp) at startup, exposed via endpoint.
 *   - endpoint reports commitsBehind = commits between boot SHA and HEAD (0 when up-to-date).
 *   - graceful when boot SHA unknown / not in history → neutral "unknown",
 *     never crash, never a misleading large N (commitsBehind MUST be null).
 *
 * OUT-OF-SCOPE this task (covered later): staleness banner, no-nag cadence,
 * doctor check, warn-not-block UX.
 *
 * Contract (implementer): GET /api/daemon-health →
 *   { success:true, data:{ bootSha, bootTime, headSha, commitsBehind, state } },
 *   state ∈ "current"|"behind"|"unknown"; pure computeStaleness(bootSha, headSha, probe).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  type BootBuild,
  computeStaleness,
  type GitProbe,
} from "../../src/daemon/build-state";
import { mountDaemonHealthRoute } from "../../src/daemon/routes/daemon-health";

interface HealthData {
  bootSha: string | null;
  bootTime: string | null;
  headSha: string | null;
  commitsBehind: number | null;
  state: "current" | "behind" | "unknown";
}

/**
 * A fully-controllable GitProbe stub — fails the test loudly if a
 * branch we did not expect to call the probe actually calls it.
 */
function stubProbe(over: Partial<GitProbe> = {}): GitProbe {
  return {
    headSha: over.headSha ?? (() => null),
    isAncestor: over.isAncestor ?? (() => null),
    countBetween: over.countBetween ?? (() => null),
  };
}

/** Mount the REAL route with injected deps, return a fetch-driver bound to it. */
function mount(boot: BootBuild, probe: GitProbe) {
  const app = new Hono();
  mountDaemonHealthRoute(app, { readBootBuild: () => boot, gitProbe: probe });
  return async (): Promise<{
    status: number;
    success: boolean;
    data: HealthData;
  }> => {
    const res = await app.request("/api/daemon-health");
    const body = (await res.json()) as { success: boolean; data: HealthData };
    return { status: res.status, success: body.success, data: body.data };
  };
}

// ---------------------------------------------------------------------------
// Boot SHA + boot timestamp captured and exposed via the endpoint.
// Observable bar: the HTTP envelope echoes the boot build the daemon captured.
// ---------------------------------------------------------------------------
describe("daemon exposes its boot build (SHA + timestamp)", () => {
  test("endpoint surfaces the captured bootSha and bootTime verbatim", async () => {
    const boot: BootBuild = {
      bootSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bootTime: "2026-06-13T20:15:03-07:00",
    };
    const get = mount(
      boot,
      stubProbe({ headSha: () => boot.bootSha }),
    );
    const { status, success, data } = await get();

    expect(status).toBe(200);
    expect(success).toBe(true);
    // The promised envelope keys are all present.
    expect(data).toHaveProperty("bootSha");
    expect(data).toHaveProperty("bootTime");
    expect(data).toHaveProperty("headSha");
    expect(data).toHaveProperty("commitsBehind");
    expect(data).toHaveProperty("state");
    // And echo what the daemon captured at boot.
    expect(data.bootSha).toBe(boot.bootSha);
    expect(data.bootTime).toBe(boot.bootTime);
  });
});

// ---------------------------------------------------------------------------
// commitsBehind = commits between boot SHA and HEAD; 0 when up-to-date.
// ---------------------------------------------------------------------------
describe("commitsBehind reflects distance from boot SHA to repo HEAD", () => {
  test("up-to-date (boot === HEAD) → commitsBehind 0, state 'current', no probe walk", async () => {
    const sha = "1111111111111111111111111111111111111111";
    const get = mount(
      { bootSha: sha, bootTime: "2026-06-13T00:00:00Z" },
      stubProbe({
        headSha: () => sha,
        // If equality short-circuits correctly these must NOT be consulted.
        isAncestor: () => {
          throw new Error("isAncestor must not be called when boot === HEAD");
        },
        countBetween: () => {
          throw new Error("countBetween must not be called when boot === HEAD");
        },
      }),
    );
    const { data } = await get();
    expect(data.state).toBe("current");
    expect(data.commitsBehind).toBe(0);
    expect(data.headSha).toBe(sha);
  });

  test("behind by N (boot is ancestor of HEAD) → commitsBehind N, state 'behind'", async () => {
    const boot = "2222222222222222222222222222222222222222";
    const head = "3333333333333333333333333333333333333333";
    const ancestorArgs: string[] = [];
    const countArgs: string[] = [];
    const get = mount(
      { bootSha: boot, bootTime: "2026-06-13T00:00:00Z" },
      stubProbe({
        headSha: () => head,
        isAncestor: (a, d) => {
          ancestorArgs.push(a, d);
          return true;
        },
        countBetween: (f, t) => {
          countArgs.push(f, t);
          return 7;
        },
      }),
    );
    const { data } = await get();
    expect(data.state).toBe("behind");
    expect(data.commitsBehind).toBe(7);
    expect(data.headSha).toBe(head);
    // The count is genuinely boot..HEAD, not some other pair.
    expect(ancestorArgs).toEqual([boot, head]);
    expect(countArgs).toEqual([boot, head]);
  });
});

// ---------------------------------------------------------------------------
// Highest-value: every "unknown" branch must report commitsBehind === null
// (a real null, NOT a number, NOT a misleading large N), state "unknown",
// status 200 (never a crash / 500).
// ---------------------------------------------------------------------------
describe("unknown state never leaks a number, never crashes", () => {
  const realHead = "4444444444444444444444444444444444444444";

  // Each case is an independent way the daemon's version can become unknowable.
  const cases: Array<{
    name: string;
    boot: BootBuild;
    probe: GitProbe;
  }> = [
    {
      name: "boot SHA null (non-git checkout / installed plugin)",
      boot: { bootSha: null, bootTime: null },
      probe: stubProbe({ headSha: () => realHead }),
    },
    {
      name: "HEAD null (git absent at request time)",
      boot: { bootSha: realHead, bootTime: "2026-06-13T00:00:00Z" },
      probe: stubProbe({ headSha: () => null }),
    },
    {
      name: "boot NOT an ancestor of HEAD (force-push / rebase)",
      boot: { bootSha: "deadbeef00000000000000000000000000000000", bootTime: "x" },
      probe: stubProbe({
        headSha: () => realHead,
        isAncestor: () => false,
      }),
    },
    {
      name: "isAncestor probe error (git errored, not a clean false)",
      boot: { bootSha: "5555555555555555555555555555555555555555", bootTime: "x" },
      probe: stubProbe({
        headSha: () => realHead,
        isAncestor: () => null,
      }),
    },
    {
      name: "countBetween returns null (rev-list errored after ancestor ok)",
      boot: { bootSha: "6666666666666666666666666666666666666666", bootTime: "x" },
      probe: stubProbe({
        headSha: () => realHead,
        isAncestor: () => true,
        countBetween: () => null,
      }),
    },
    {
      name: "countBetween returns 0 (no positive distance) → still unknown, not 'behind 0'",
      boot: { bootSha: "7777777777777777777777777777777777777777", bootTime: "x" },
      probe: stubProbe({
        headSha: () => realHead,
        isAncestor: () => true,
        countBetween: () => 0,
      }),
    },
    {
      name: "headSha() THROWS at request time → route catches, degrades to unknown + 200",
      boot: { bootSha: realHead, bootTime: "x" },
      probe: stubProbe({
        headSha: () => {
          throw new Error("simulated git spawn failure");
        },
      }),
    },
    {
      name: "isAncestor() THROWS mid-derivation → route catches, degrades to unknown + 200",
      boot: { bootSha: "8888888888888888888888888888888888888888", bootTime: "x" },
      probe: stubProbe({
        headSha: () => realHead,
        isAncestor: () => {
          throw new Error("simulated merge-base spawn failure");
        },
      }),
    },
  ];

  for (const { name, boot, probe } of cases) {
    test(`unknown branch — ${name}`, async () => {
      const get = mount(boot, probe);
      const { status, success, data } = await get();

      // never crashes
      expect(status).toBe(200);
      expect(success).toBe(true);
      // neutral state
      expect(data.state).toBe("unknown");
      // THE property: commitsBehind is a real null, never a number, never a large N.
      expect(data.commitsBehind).toBeNull();
      expect(typeof data.commitsBehind).not.toBe("number");
    });
  }

  test("pure contract: computeStaleness never returns a number in any unknown branch", () => {
    const head = "9999999999999999999999999999999999999999";
    const boot = "abcabcabcabcabcabcabcabcabcabcabcabcabca0";
    const branches: Staleness6[] = [
      computeStaleness(null, head, stubProbe()),
      computeStaleness(boot, null, stubProbe()),
      computeStaleness(boot, head, stubProbe({ isAncestor: () => false })),
      computeStaleness(boot, head, stubProbe({ isAncestor: () => null })),
      computeStaleness(
        boot,
        head,
        stubProbe({ isAncestor: () => true, countBetween: () => null }),
      ),
      computeStaleness(
        boot,
        head,
        stubProbe({ isAncestor: () => true, countBetween: () => 0 }),
      ),
    ];
    for (const r of branches) {
      expect(r.state).toBe("unknown");
      expect(r.commitsBehind).toBeNull();
    }
  });
});

type Staleness6 = ReturnType<typeof computeStaleness>;
