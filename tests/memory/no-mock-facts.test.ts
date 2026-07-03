import { describe, expect, it } from "bun:test";
import { $ } from "bun";
it("no MOCK_FACTS reference remains in shipped src/web or src/daemon", async () => {
  const res = await $`grep -rn MOCK_FACTS src/web src/daemon`.nothrow().quiet();
  expect(res.exitCode).not.toBe(0); // grep exits non-zero when no match
});
