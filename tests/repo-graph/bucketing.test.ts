/**
 * Unit tests for the generic-bucketing primitive `deriveContainers`.
 *
 * Three gates:
 *   1. Nested catch-all synthetic fixture proves clean termination (no stack
 *      overflow) + the depth-cap backstop fires. Ordinary repos terminate at
 *      one descent level, so this case must be synthetic.
 *   2. Per-fixture after-snapshot, byte-locked — any drift fails the test.
 *   3. Zero-name guard: the primitive hardcodes no directory / framework /
 *      repo name (greps its own source).
 *
 * Fixtures are synthetic path listings (`fixtures/bucketing/*-paths.json`)
 * shaped to exercise the algorithm — a parent that expands into medium
 * fan-out children, a large flat directory that stays whole, etc. `siltpoke`
 * is this repo's own top-level layout.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  containerForPath,
  DEFAULT_DEPTH_CAP,
  deriveContainers,
} from "../../src/repo-graph/bucketing";

const FIX = join(import.meta.dir, "fixtures", "bucketing");
const loadPaths = (repo: string): string[] =>
  JSON.parse(readFileSync(join(FIX, `${repo}-paths.json`), "utf8"));

// ---------------------------------------------------------------------------
// Gate 2 — per-fixture after-snapshot, byte-locked. The exact container lists
// are the oracle; any drift fails the test.
// ---------------------------------------------------------------------------

const SNAPSHOTS: Record<string, string[]> = {
  siltpoke: [
    "scripts/",
    "src/brain/",
    "src/chat/",
    "src/cli/",
    "src/config/",
    "src/critic/",
    "src/daemon/",
    "src/eval/",
    "src/explain/",
    "src/face/",
    "src/few-shot/",
    "src/hooks/",
    "src/installer/",
    "src/memory/",
    "src/observability/",
    "src/preference-log/",
    "src/repo-graph/",
    "src/repo-memory/",
    "src/router/",
    "src/state/",
    "src/utils/",
    "src/web/",
  ],
  "repo-a": [
    "src/cli/",
    "src/core/",
    "src/hooks/",
    "src/server/",
    "src/shared/",
    "src/store/",
  ],
  "repo-b": [
    "engine/phases/phase-a/",
    "engine/phases/phase-b/",
    "engine/phases/phase-c/",
    "engine/phases/phase-d/",
    "engine/phases/phase-e/",
  ],
  "repo-c": [
    "scripts/",
    "service/domains/domain-01/",
    "service/domains/domain-02/",
    "service/domains/domain-03/",
    "service/domains/domain-04/",
    "service/domains/domain-05/",
    "service/domains/domain-06/",
    "service/domains/domain-07/",
    "service/domains/domain-08/",
    "service/domains/domain-09/",
    "service/domains/domain-10/",
    "service/domains/domain-11/",
    "service/settings/",
    "shared/types/generated/",
    "webapp/e2e/",
    "webapp/src/components/",
    "webapp/src/utils/",
    "webapp/src/views/",
  ],
};

describe("deriveContainers — per-fixture after-snapshot (byte-locked)", () => {
  for (const [repo, expected] of Object.entries(SNAPSHOTS)) {
    test(`${repo} → ${expected.length} containers, exact`, () => {
      const { containers, depthCapHits } = deriveContainers(loadPaths(repo));
      expect(containers).toEqual(expected);
      expect(depthCapHits).toEqual([]); // ordinary repos never hit the cap
    });
  }
});

describe("deriveContainers — container-granularity invariants", () => {
  test("siltpoke: src/web kept WHOLE (big peer module, not a catch-all)", () => {
    const { containers } = deriveContainers(loadPaths("siltpoke"));
    expect(containers).toContain("src/web/");
    expect(containers.some((c) => c.startsWith("src/web/"))).toBe(true);
    // web's own subdirs must NOT surface as containers.
    expect(containers.filter((c) => c.startsWith("src/web/")).length).toBe(1);
  });

  test("repo-c: service/domains expanded into its 11 domain modules", () => {
    const { containers } = deriveContainers(loadPaths("repo-c"));
    const domains = containers.filter((c) => c.startsWith("service/domains/"));
    expect(domains.length).toBe(11);
    expect(containers).not.toContain("service/domains/"); // the catch-all itself is gone
  });

  test("repo-c: webapp/src/views NOT exploded into its many flat files", () => {
    const { containers } = deriveContainers(loadPaths("repo-c"));
    expect(containers).toContain("webapp/src/views/");
    // kept whole: no container strictly deeper than webapp/src/views/.
    expect(
      containers.some(
        (c) => c.startsWith("webapp/src/views/") && c !== "webapp/src/views/",
      ),
    ).toBe(false);
  });
});

describe("deriveContainers — G robustness (empty zone)", () => {
  test("G=6 and G=8 are byte-identical on all fixtures", () => {
    for (const repo of Object.keys(SNAPSHOTS)) {
      const paths = loadPaths(repo);
      const g6 = deriveContainers(paths, { gapThreshold: 6 }).containers;
      const g8 = deriveContainers(paths, { gapThreshold: 8 }).containers;
      expect(g6).toEqual(g8);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 1 — nested catch-all termination + depth-cap backstop.
// ---------------------------------------------------------------------------

/**
 * Build a pathological NESTED catch-all tree of `levels` depth:
 * a chain d0/d1/…/d{levels-1}/ where every level has a dominant child
 * (the next link, holding all the deep files) sitting above a tiny 1-file
 * sibling — so gap-descend must recurse the dominant child at every level.
 *   - deepest dir holds `leafFiles` files → every ancestor dominates.
 *   - each level i (0..levels-2) carries a `tiny{i}/one.ts` sibling.
 */
function nestedCatchAll(levels: number, leafFiles = 20): string[] {
  const chain = Array.from({ length: levels }, (_, i) => `d${i}`);
  const deepPrefix = `${chain.join("/")}/`;
  const paths: string[] = [];
  for (let f = 0; f < leafFiles; f++) paths.push(`${deepPrefix}leaf${f}.ts`);
  for (let i = 0; i < levels - 1; i++) {
    const sib = `${chain.slice(0, i + 1).join("/")}/tiny${i}/one.ts`;
    paths.push(sib);
  }
  return paths;
}

describe("deriveContainers — nested catch-all termination", () => {
  test("descends every level cleanly, no stack overflow (depth 6 < cap)", () => {
    const paths = nestedCatchAll(6);
    const { containers, depthCapHits } = deriveContainers(paths);
    // 5 tiny siblings (levels 0..4) + the single deepest container.
    expect(containers).toContain("d0/d1/d2/d3/d4/d5/");
    expect(containers).toContain("d0/tiny0/");
    expect(containers).toContain("d0/d1/d2/d3/d4/tiny4/");
    expect(containers.length).toBe(6);
    expect(depthCapHits).toEqual([]); // below the cap → no backstop needed
  });

  test("terminates on an extreme depth without throwing (1000 levels)", () => {
    // The real guarantee: bounded recursion regardless of input depth.
    expect(() => deriveContainers(nestedCatchAll(1000))).not.toThrow();
  });
});

describe("deriveContainers — depth-cap backstop", () => {
  test("depth beyond the cap stops at the cap layer + records a marker", () => {
    const levels = DEFAULT_DEPTH_CAP + 5; // exceed the cap by 5
    const { containers, depthCapHits } = deriveContainers(
      nestedCatchAll(levels),
    );
    // Marker fired.
    expect(depthCapHits.length).toBeGreaterThan(0);
    // Boundedness: no container is deeper than the cap (segment count).
    for (const c of containers) {
      const segs = c.replace(/\/$/, "").split("/");
      expect(segs.length).toBeLessThanOrEqual(DEFAULT_DEPTH_CAP);
    }
    // The capped container sits exactly at the cap depth and is recorded.
    expect(depthCapHits.every((p) => p.replace(/\/$/, "").split("/").length === DEFAULT_DEPTH_CAP)).toBe(true);
  });

  test("a custom depthCap is honored", () => {
    const { depthCapHits, containers } = deriveContainers(nestedCatchAll(10), {
      depthCap: 4,
    });
    expect(depthCapHits.length).toBeGreaterThan(0);
    for (const c of containers) {
      expect(c.replace(/\/$/, "").split("/").length).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// containerForPath — map a file path to its deepest containing container
// (file→container resolution for counts + edges).
// ---------------------------------------------------------------------------

describe("containerForPath — deepest-prefix file→container mapping", () => {
  test("maps a file to the single container that prefixes it", () => {
    expect(containerForPath("src/web/client/x.ts", ["src/web/", "src/critic/"])).toBe(
      "src/web/",
    );
  });

  test("nested containers → deepest wins", () => {
    expect(
      containerForPath("src/web/client/x.ts", ["src/web/", "src/web/client/"]),
    ).toBe("src/web/client/");
  });

  test("a file under no container → null (honest, excluded)", () => {
    expect(containerForPath("scripts/x.ts", ["src/web/"])).toBeNull();
  });

  test("a loose file at a namespace level (no container prefix) → null", () => {
    // src/foo.ts is NOT under src/web/ — file-as-bucket noise is gone.
    expect(containerForPath("src/foo.ts", ["src/web/"])).toBeNull();
  });

  test("partial-segment overlap does NOT count as a prefix", () => {
    // "src/web/" must not swallow "src/website/x.ts".
    expect(containerForPath("src/website/x.ts", ["src/web/"])).toBeNull();
  });

  test("every fixture file resolves to exactly one derived container or null", () => {
    const paths: string[] = JSON.parse(
      readFileSync(join(FIX, "repo-c-paths.json"), "utf8"),
    );
    const { containers } = deriveContainers(paths);
    for (const p of paths) {
      const c = containerForPath(p, containers);
      // when non-null, the result must be one of the derived containers + a real prefix
      if (c !== null) {
        expect(containers).toContain(c);
        expect(p.startsWith(c)).toBe(true);
      }
    }
  });
});

describe("bucketing.ts — zero-name red line", () => {
  test("source contains no forbidden dir/framework/repo name literal", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "repo-graph", "bucketing.ts"),
      "utf8",
    );
    const FORBIDDEN = [
      // common framework / directory names the algorithm must not hardcode
      "src",
      "lib",
      "packages",
      "app",
      "apps",
      "dist",
      "build",
      "components",
      "pages",
      "backend",
      "frontend",
      "node_modules",
      "__tests__",
      // framework identifiers
      "django",
      "next",
      "react",
      "siltpoke",
    ];
    const hits = FORBIDDEN.filter((name) =>
      new RegExp(`['"\`]${name}['"\`]`).test(src),
    );
    expect(hits).toEqual([]);
  });
});
