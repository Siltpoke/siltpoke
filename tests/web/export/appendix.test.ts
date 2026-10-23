import { describe, expect, test } from "bun:test";
import { buildAppendixMd } from "../../../src/web/client/export/appendix";
import { assertNoAbsolutePaths } from "../../../src/web/client/export/privacy";
import { model, STAMP, trust } from "./fixtures";

describe("buildAppendixMd", () => {
  const md = buildAppendixMd(model(), trust(), STAMP);
  test("carries the stamp and one section per container", () => {
    expect(md).toContain(STAMP);
    for (const t of ["Alpha core", "Beta store", "Gamma"]) expect(md).toContain(`## ${t}`);
  });
  test("folder lines with coverage and exact listed files", () => {
    expect(md).toContain("`src/a` — AI listed 2 of 4 files");
    expect(md).toContain("`src/b2` — AI listed 3 of 9 files");
    expect(md).toContain("- `src/a/x.ts`");
    expect(md).toContain("- `src/b/z.ts`");
  });
  test("edge table rows for import, cited, and none", () => {
    expect(md).toContain("a → b | uses | import ×3");
    expect(md).toContain("a → ext | calls | cited web/api.ts:40");
    expect(md).toContain("b → c | writes | none (citation-stale)");
  });
  test("names non-container endpoints so the edge table reads", () => {
    expect(md).toContain("- `ext` — Some API");
  });
  test("lists every not-shown folder", () => {
    expect(md).toContain("Not shown: src/zz");
  });
  test("never exports the on-screen Key pieces (comp)", () => {
    expect(md).not.toContain("SECRET-COMP-FILE");
    expect(md).not.toContain("key piece desc");
  });
  test("passes the absolute-path assert and has no listed-files section when none were sent", () => {
    expect(() => assertNoAbsolutePaths(md)).not.toThrow();
    const bare = buildAppendixMd(
      model(),
      trust({ containers: trust().containers.map((c) => ({ ...c, listedFiles: [] })) }),
      STAMP,
    );
    expect(bare).not.toContain("Listed files");
  });
  test("cell text cannot break the table", () => {
    const m = model();
    m.E[0] = ["a", "b", "a | b\nc"]; // the drawn verb is the one the table lists
    expect(buildAppendixMd(m, trust(), STAMP)).toContain("a → b | a \\| b c | import ×3");
  });
  test("cited evidence matches the file:line shape", () => {
    expect(md).toMatch(/cited [\w./-]+:\d+/);
  });
});

describe("edge ids in the table", () => {
  test("a pipe in a node id cannot add a column", () => {
    const t = trust();
    t.edges[0] = { ...t.edges[0], source: "a|x", target: "b" };
    expect(buildAppendixMd(model(), t, STAMP)).toContain("| a\\|x → b | uses | import ×3 |");
  });
});
