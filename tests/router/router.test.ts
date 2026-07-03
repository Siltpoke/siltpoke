import { test, expect } from "bun:test";
import { shouldFire } from "../../src/router/router";

const validStop = {
  hook_event_name: "Stop",
  session_id: "abc",
  transcript_path: "/tmp/x.jsonl",
  cwd: "/tmp",
};

test("fires on valid Stop event", () => {
  expect(shouldFire(validStop, {}).fire).toBe(true);
});

test("skips when SILTPOKE_INTERNAL=1", () => {
  const d = shouldFire(validStop, { SILTPOKE_INTERNAL: "1" });
  expect(d.fire).toBe(false);
  expect(d.reason).toBe("recursion_guard");
});

test("skips when hook_event_name is not Stop", () => {
  const d = shouldFire({ ...validStop, hook_event_name: "PreCompact" }, {});
  expect(d.fire).toBe(false);
  expect(d.reason).toBe("wrong_event");
});

test("skips when session_id missing", () => {
  const d = shouldFire({ ...validStop, session_id: undefined }, {});
  expect(d.fire).toBe(false);
  expect(d.reason).toBe("missing_fields");
});

test("skips when transcript_path missing", () => {
  const d = shouldFire({ ...validStop, transcript_path: undefined }, {});
  expect(d.fire).toBe(false);
  expect(d.reason).toBe("missing_fields");
});
