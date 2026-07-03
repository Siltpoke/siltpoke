import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../../src/hooks/on-stop";
import type { BrainOutput } from "../../../src/brain/schema";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hook-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("malformed stdin JSON logs error and exits cleanly", async () => {
  await runHook({ rawJson: "not json", env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" } });
  const logPath = join(tmpHome, ".siltpoke", "brain-calls.jsonl");
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf8")).toContain("stdin not valid JSON");
});

test("SILTPOKE_INTERNAL=1 produces a skip log entry", async () => {
  const event = {
    hook_event_name: "Stop",
    session_id: "abc",
    transcript_path: join(tmpHome, "missing.jsonl"),
    cwd: "/tmp",
  };
  await runHook({
    rawJson: JSON.stringify(event),
    env: { SILTPOKE_INTERNAL: "1", HOME: tmpHome },
  });
  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  expect(log).toContain('"skipped":"recursion_guard"');
});

test("missing session_id produces a skip log entry", async () => {
  const event = {
    hook_event_name: "Stop",
    transcript_path: join(tmpHome, "missing.jsonl"),
    cwd: "/tmp",
  };
  await runHook({ rawJson: JSON.stringify(event), env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" } });
  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  expect(log).toContain('"skipped":"missing_fields"');
});

test("non-Stop event produces a skip log entry", async () => {
  const event = {
    hook_event_name: "PreCompact",
    session_id: "abc",
    transcript_path: join(tmpHome, "missing.jsonl"),
    cwd: "/tmp",
  };
  await runHook({ rawJson: JSON.stringify(event), env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" } });
  const log = readFileSync(
    join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
    "utf8",
  );
  expect(log).toContain('"skipped":"wrong_event"');
});
