import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAck } from "../../src/cli/ack";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-ack-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(id: string, status: "pending" | "acked" = "pending"): string {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(
    path,
    `---\nschemaVersion: 1\ncritique_id: ${id}\nstatus: ${status}\n---\nbody\n`,
  );
  return path;
}

test("ack: not_found for unknown id", async () => {
  const r = await runAck({ critiqueId: "c-zzzz", basePath: tmp });
  expect(r.status_set).toBe("not_found");
});

test("ack: flips pending → acked", async () => {
  const path = seed("c-ack1");
  const r = await runAck({
    critiqueId: "c-ack1",
    basePath: tmp,
    preferenceLogPath: join(tmp, "preference-log.jsonl"),
  });
  expect(r.status_set).toBe("acked");
  expect(readFileSync(path, "utf8")).toContain("status: acked");
});

test("ack: already_acked is idempotent", async () => {
  seed("c-ack2", "acked");
  const r = await runAck({
    critiqueId: "c-ack2",
    basePath: tmp,
    preferenceLogPath: join(tmp, "preference-log.jsonl"),
  });
  expect(r.status_set).toBe("already_acked");
});

test("ack: preference entry goes to injected path, not the global default", async () => {
  seed("c-prefpath");
  const prefLog = join(tmp, "preference-log.jsonl");
  await runAck({
    critiqueId: "c-prefpath",
    basePath: tmp,
    preferenceLogPath: prefLog,
  });
  // appendPreferenceEntry is fire-and-forget inside runAck; give the
  // microtask a tick to flush before asserting.
  await new Promise((r) => setTimeout(r, 25));
  expect(existsSync(prefLog)).toBe(true);
  expect(readFileSync(prefLog, "utf8")).toContain("c-prefpath");
});
