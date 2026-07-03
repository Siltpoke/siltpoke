/**
 * The architecture view — C4 model integrity.
 *
 * No DOM. Catches port typos in the authored C4 model before any rendering exists:
 *   - every edge endpoint references a real node
 *   - every container has a valid accent + a drillTo pointing at a REAL src/ subdir
 *   - person/ext nodes are non-drillable (no drillTo)
 *   - every container sits in the band its accent maps to
 *   - layout positions are sane (positive w/h)
 *
 * The valid-subdir set is read from the actual src/ tree, so a renamed/removed
 * subdir makes a stale drillTo fail loudly here instead of dead-ending a user.
 */
import { test, expect, describe } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BAND_BY_ACCENT,
  type C4Accent,
} from "../../../src/web/client/islands/repo-graph-c4-model";
import { ARCH_C4_FILENAME, loadAuthoredC4 } from "../../../src/web/arch-c4-file";

// siltpoke-generate follow-up: siltpoke's live .siltpoke/arch-c4.json was
// removed (the repo behaves like any other; the hand-drawn model survives
// in git history and as this fixture). The test still exercises the REAL
// loader + Zod schema on a REAL file: the former in-house model, staged
// into a temp project root.
const FIXTURE = join(import.meta.dir, "../../fixtures/arch-c4.fixture.json");
const tmpRoot = mkdtempSync(join(tmpdir(), "arch-c4-fixture-"));
mkdirSync(join(tmpRoot, ".siltpoke"), { recursive: true });
copyFileSync(FIXTURE, join(tmpRoot, ARCH_C4_FILENAME));
const loaded = await loadAuthoredC4(tmpRoot);
rmSync(tmpRoot, { recursive: true, force: true });
if (!loaded.model) throw new Error("arch-c4 fixture missing or failed validation");
const C4_MODEL = loaded.model;

const SRC_DIR = join(import.meta.dir, "../../../src");
const realSubdirs = new Set(
  readdirSync(SRC_DIR).filter((n) => {
    try {
      return statSync(join(SRC_DIR, n)).isDirectory();
    } catch {
      return false;
    }
  }),
);

const { N, E, BANDS, GROUP_ACCENT } = C4_MODEL;
const conts = Object.entries(N).filter(([, n]) => n.kind === "cont");
const accents = new Set<C4Accent>(["sky", "terra", "moss", "amber"]);
const bandLabels = new Set(BANDS.map((b) => b.label));

describe("C4 model integrity (the architecture view)", () => {
  test("every edge endpoint references a real node", () => {
    for (const [s, t, label] of E) {
      expect(N[s], `edge source "${s}" (→ ${t}) not in N`).toBeDefined();
      expect(N[t], `edge target "${t}" (${s} →) not in N`).toBeDefined();
      expect(label.length, `edge ${s}→${t} has empty label`).toBeGreaterThan(0);
    }
  });

  test("every container has a valid accent", () => {
    for (const [id, n] of conts) {
      expect(n.accent, `container "${id}" missing accent`).toBeDefined();
      expect(accents.has(n.accent as C4Accent), `container "${id}" bad accent "${n.accent}"`).toBe(true);
    }
  });

  test("every container drillTo points at a REAL src/ subdir", () => {
    for (const [id, n] of conts) {
      expect(n.drillTo, `container "${id}" missing drillTo`).toBeDefined();
      expect(
        realSubdirs.has(n.drillTo as string),
        `container "${id}" drillTo "${n.drillTo}" is not a real src/ subdir`,
      ).toBe(true);
    }
  });

  test("person/ext nodes are non-drillable (no drillTo)", () => {
    for (const [id, n] of Object.entries(N)) {
      if (n.kind === "person" || n.kind === "ext") {
        expect(n.drillTo, `${n.kind} node "${id}" must not have drillTo`).toBeUndefined();
      }
    }
  });

  test("every container's accent maps to an existing band", () => {
    for (const [id, n] of conts) {
      const band = BAND_BY_ACCENT[n.accent as C4Accent];
      expect(bandLabels.has(band), `container "${id}" accent "${n.accent}" → band "${band}" not in BANDS`).toBe(true);
    }
  });

  test("GROUP_ACCENT covers all four layer accents", () => {
    for (const a of accents) {
      expect(GROUP_ACCENT[a], `GROUP_ACCENT missing "${a}"`).toBeDefined();
    }
  });

  test("all nodes have sane positive dimensions", () => {
    for (const [id, n] of Object.entries(N)) {
      expect(n.w, `node "${id}" w`).toBeGreaterThan(0);
      expect(n.h, `node "${id}" h`).toBeGreaterThan(0);
    }
  });

  test("expected shape: 1 person + 3 ext + ~19 containers", () => {
    const kinds = Object.values(N).reduce<Record<string, number>>((acc, n) => {
      acc[n.kind] = (acc[n.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds.person).toBe(1);
    expect(kinds.ext).toBe(3);
    expect(kinds.cont).toBeGreaterThanOrEqual(18);
  });
});
