/** Which indexed files a Code Map view leaves out.
 *
 * The header says "5 files", the boxes added up to 4, and nothing said which
 * one was missing (agent-runtime, 2026-10-15). These functions name the
 * missing files so the page can say so.
 */
import { describe, expect, it } from "bun:test";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import {
  filesOutsideBuckets,
  filesOutsideGenerated,
  summarizeUndrawn,
  UNDRAWN_EXAMPLE_CAP,
} from "../../src/repo-graph/undrawn-files";

const subdirs = [
  { id: "utils", path: "utils/" },
  { id: "(root)", path: "" },
];

function cont(id: string, members: string[], drillTo?: string): ArchModelDoc["nodes"][number] {
  return {
    id,
    kind: "cont",
    title: { value: id, evidence: [] },
    band: { value: "b", evidence: [] },
    members,
    ...(drillTo ? { drillTo } : {}),
  };
}
function doc(nodes: ArchModelDoc["nodes"]): ArchModelDoc {
  return { boundary: "r", bands: [], nodes, edges: [] };
}

describe("filesOutsideBuckets (Auto / authored-overlay view)", () => {
  it("lists files no bucket claims, sorted", () => {
    // rich mode drops out-of-root files: here only utils/ is a bucket
    const only = [{ id: "utils", path: "utils/" }];
    expect(filesOutsideBuckets(only, ["utils/a.py", "scripts/z.ts", "main.py"])).toEqual(["main.py", "scripts/z.ts"]);
  });

  it("is empty when every file has a bucket", () => {
    expect(filesOutsideBuckets(subdirs, ["main.py", "utils/a.py"])).toEqual([]);
  });
});

describe("filesOutsideGenerated (Generated view)", () => {
  const files = ["main.py", "utils/config.py", "utils/helpers.py", "utils/prompts.py", "utils/tools.py"];

  it("agent-runtime's 2026-10-15 model: two split boxes in utils/ leave three files out", () => {
    // The real cached model: both containers split utils/ (comp: ids), each
    // listing one file. main.py, config.py and prompts.py were in no box.
    const d = doc([
      cont("comp:utils/llm-processing", ["utils/helpers.py"], "utils"),
      cont("comp:utils/agent-tools", ["utils/tools.py"], "utils"),
    ]);
    expect(filesOutsideGenerated(d, subdirs, files)).toEqual(["main.py", "utils/config.py", "utils/prompts.py"]);
  });

  it("a whole-folder box (not a comp: split) covers every file in its folder", () => {
    const d = doc([cont("utils", ["utils/helpers.py"], "utils"), cont("(root)", ["main.py"], "(root)")]);
    expect(filesOutsideGenerated(d, subdirs, files)).toEqual([]);
  });

  it("a whole-folder box does not cover a folder another box splits into comp: parts", () => {
    // "utils" claims the folder whole, but a comp: box also splits it — the
    // folder is not owned by one box, so only listed files count there.
    const d = doc([cont("utils", ["utils/helpers.py"], "utils"), cont("comp:utils/x", ["utils/tools.py"], "utils")]);
    expect(filesOutsideGenerated(d, subdirs, files)).toEqual(["main.py", "utils/config.py", "utils/prompts.py"]);
  });

  it("ignores non-container nodes (an external node's members cover nothing)", () => {
    const d = doc([{ ...cont("ext", ["main.py"]), kind: "ext" } as ArchModelDoc["nodes"][number]]);
    expect(filesOutsideGenerated(d, subdirs, ["main.py"])).toEqual(["main.py"]);
  });
});

describe("summarizeUndrawn", () => {
  it("keeps the true count and caps the example list", () => {
    const many = Array.from({ length: UNDRAWN_EXAMPLE_CAP + 5 }, (_, i) => `f${i}.ts`);
    const s = summarizeUndrawn(many);
    expect(s.count).toBe(UNDRAWN_EXAMPLE_CAP + 5);
    expect(s.examples).toHaveLength(UNDRAWN_EXAMPLE_CAP);
  });
});
