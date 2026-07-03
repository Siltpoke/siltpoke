/** siltpoke-generate no-name-matching guard (认名字病 discipline, same
 * family as the zero-framework-name bucketing guard).
 *
 * Authored detection must be "file present", never "repo named X". This guard
 * greps the arch-source detection path for (a) an exact quoted `siltpoke`
 * string literal (the ===-comparable shape a name check needs — longer strings
 * like the `.siltpoke/arch-c4.json` path constant don't match), and (b) the
 * deleted name-check identifiers, so they can't quietly return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
/** The arch-source detection/gate path — keep this list in sync. */
const GUARDED = [
  "src/web/client/islands/repo-graph.ts",
  "src/web/client/islands/repo-graph-c4-model.ts",
  "src/web/client/islands/repo-graph-c4-adapter.ts",
  "src/web/client/islands/repo-graph-c4-derive.ts",
  "src/web/arch-c4-file.ts",
  "src/web/routes/repo-graph.tsx",
];

describe("authored detection is never name-keyed", () => {
  test("no exact quoted `siltpoke` literal anywhere in the detection path", () => {
    for (const rel of GUARDED) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const hits = src.match(/["'`]siltpoke["'`]/g) ?? [];
      expect({ file: rel, hits }).toEqual({ file: rel, hits: [] });
    }
  });

  test("the deleted name-check identifiers never return", () => {
    for (const rel of GUARDED) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect({ file: rel, hasRepoNameCheck: /C4_MODEL_REPO|repoHasC4Model/.test(src) }).toEqual({
        file: rel,
        hasRepoNameCheck: false,
      });
    }
  });
});
