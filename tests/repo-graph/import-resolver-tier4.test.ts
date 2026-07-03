/**
 * Tier-4 alias / source-root resolution (alias-edge resolution).
 * Covers: TS nearest-config + longest-prefix, Python roots,
 *         unique-or-null, no anchorMap → byte-identical tier-1–3.
 */
import { describe, expect, test } from "bun:test";
import { resolveImportTarget } from "../../src/repo-graph/import-resolver";
import type { AnchorMap } from "../../src/repo-graph/types";

const idx = new Set([
  "frontend/src/util.ts",
  "frontend/src/index.ts",
  "frontend/lib/helper.ts",
  "frontend/src/dupName.ts",
  "frontend/lib/dupName.ts",
  "backend/apps/accounts/models.py",
  "backend/apps/accounts/__init__.py",
  "backend/apps/accounts/views.py",
]);

const anchorMap: AnchorMap = {
  tsAliases: [
    { scopeDir: "frontend/", prefix: "@/", targets: ["frontend/src/"] },
    { scopeDir: "frontend/", prefix: "@app/", targets: ["frontend/lib/"] },
    { scopeDir: "frontend/", prefix: "@dup/", targets: ["frontend/src/", "frontend/lib/"] },
  ],
  pythonRoots: ["backend/"],
};

describe("resolveImportTarget — tier-4 anchors", () => {
  test("TS alias resolves to the real file", () => {
    expect(resolveImportTarget("frontend/src/index.ts", "@/util", idx, anchorMap))
      .toBe("frontend/src/util.ts");
    expect(resolveImportTarget("frontend/src/index.ts", "@app/helper", idx, anchorMap))
      .toBe("frontend/lib/helper.ts");
  });

  test("Python source-root resolves a non-repo-root absolute import", () => {
    expect(
      resolveImportTarget("backend/apps/accounts/views.py", "apps.accounts.models", idx, anchorMap),
    ).toBe("backend/apps/accounts/models.py");
  });

  test("ambiguous multi-target alias (both targets exist) → null", () => {
    expect(resolveImportTarget("frontend/src/index.ts", "@dup/dupName", idx, anchorMap)).toBeNull();
  });

  test("unresolvable alias → null", () => {
    expect(resolveImportTarget("frontend/src/index.ts", "@/missing", idx, anchorMap)).toBeNull();
  });

  test("no anchorMap → tier-4 disabled, alias stays null (byte-identical)", () => {
    expect(resolveImportTarget("frontend/src/index.ts", "@/util", idx)).toBeNull();
    // a relative import still resolves with no anchorMap (tier-1–3 untouched):
    expect(resolveImportTarget("frontend/src/index.ts", "./util", idx)).toBe("frontend/src/util.ts");
  });
});

// The fall-through contract (the pinned edge): longest matching prefix is tried
// first; if it yields NO file, resolution falls through to a shorter prefix —
// a naive break-on-match would wrongly return null here.
describe("resolveImportTarget — TS prefix fall-through (most-specific first)", () => {
  const fidx = new Set(["frontend/src/sub/thing.ts", "frontend/other/thing.ts"]);

  test("longest prefix misses (no file) → falls through to shorter prefix that resolves", () => {
    const am: AnchorMap = {
      tsAliases: [
        { scopeDir: "frontend/", prefix: "@/sub/", targets: ["frontend/x/"] }, // most-specific, no file
        { scopeDir: "frontend/", prefix: "@/", targets: ["frontend/src/"] },   // shorter, resolves
      ],
      pythonRoots: [],
    };
    expect(resolveImportTarget("frontend/src/index.ts", "@/sub/thing", fidx, am))
      .toBe("frontend/src/sub/thing.ts");
  });

  test("longest prefix resolves → it wins deterministically (shorter prefix not consulted)", () => {
    const am: AnchorMap = {
      tsAliases: [
        { scopeDir: "frontend/", prefix: "@/sub/", targets: ["frontend/other/"] }, // resolves → wins
        { scopeDir: "frontend/", prefix: "@/", targets: ["frontend/src/"] },
      ],
      pythonRoots: [],
    };
    expect(resolveImportTarget("frontend/src/index.ts", "@/sub/thing", fidx, am))
      .toBe("frontend/other/thing.ts");
  });
});
