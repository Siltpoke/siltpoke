import { describe, expect, it } from "bun:test";
import { UNDRAWN_INLINE_MAX, undrawnLine } from "../../../src/web/client/islands/repo-graph-undrawn";

describe("undrawnLine", () => {
  it("names the files when there are only a few (agent-runtime's Generated view)", () => {
    const line = undrawnLine({ count: 3, examples: ["main.py", "utils/config.py", "utils/prompts.py"] });
    expect(line?.text).toBe("· 3 files not in this diagram: main.py, utils/config.py, utils/prompts.py");
  });

  it("singular for one file", () => {
    expect(undrawnLine({ count: 1, examples: ["main.py"] })?.text).toBe("· 1 file not in this diagram: main.py");
  });

  it("counts only, with the list in the hover title, above the inline limit", () => {
    const examples = Array.from({ length: UNDRAWN_INLINE_MAX + 1 }, (_, i) => `scripts/s${i}.ts`);
    const line = undrawnLine({ count: 72, examples });
    expect(line?.text).toBe("· 72 files not in this diagram");
    expect(line?.title.split("\n").slice(0, -1)).toEqual(examples);
    expect(line?.title.endsWith(`…and ${72 - examples.length} more`)).toBe(true);
  });

  it("says nothing when every file is drawn, or the view has no summary", () => {
    expect(undrawnLine({ count: 0, examples: [] })).toBeNull();
    expect(undrawnLine(null)).toBeNull();
    expect(undrawnLine(undefined)).toBeNull();
  });
});
