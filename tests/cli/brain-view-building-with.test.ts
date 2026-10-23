// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainView } from "../../src/cli/brain-cli";

let home: string;
const SAVED_HOST = process.env.SILTPOKE_HOST;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-building-with-"));
  delete process.env.SILTPOKE_HOST;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (SAVED_HOST === undefined) delete process.env.SILTPOKE_HOST;
  else process.env.SILTPOKE_HOST = SAVED_HOST;
});

// The Settings page used to say "the code was authored by <X>", where X came
// from SILTPOKE_HOST — which the dashboard process never has — so it read
// "claude" for everyone. The agent in use is the one whose session was seen
// last (`last-host`, defect [49]); it is not a setting.
describe("brainView — the agent you are building with", () => {
  test("is the family in last-host", () => {
    writeFileSync(join(home, "last-host"), "codebuddy\n/usr/local/bin/codebuddy\n");
    expect(brainView(home).buildingWith).toBe("codebuddy");
  });

  test("is null when no session has been recorded", () => {
    expect(brainView(home).buildingWith).toBeNull();
    expect(brainView(home).buildingWithSeenAt).toBeNull();
  });

  test("carries when the record was last written", () => {
    const path = join(home, "last-host");
    writeFileSync(path, "qoder\n");
    const when = new Date("2026-09-01T08:30:00.000Z");
    utimesSync(path, when, when);
    expect(brainView(home).buildingWithSeenAt).toBe("2026-09-01T08:30:00.000Z");
  });

  test("an unusable record carries no time either", () => {
    writeFileSync(join(home, "last-host"), "not-an-agent\n");
    expect(brainView(home).buildingWithSeenAt).toBeNull();
  });

  test("is null when the record does not name one of the five agents", () => {
    writeFileSync(join(home, "last-host"), "<script>\n");
    expect(brainView(home).buildingWith).toBeNull();
  });

  test("does not come from the config's author_family or the review pin", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ brain: { author_family: "qoder", main: "agy", roles: { review: { provider: "codex" } } } }),
    );
    expect(brainView(home).buildingWith).toBeNull();
    writeFileSync(join(home, "last-host"), "agy\n");
    expect(brainView(home).buildingWith).toBe("agy");
  });
});

// Spec §12.1 / §12.4 — the "Coding agents on this machine" chips: all five, in
// FAMILIES order, each installed or not, and when a session of it was seen.
describe("brainView — agents on this machine", () => {
  const onPath = (...bins: string[]) => ({ which: (b: string) => (bins.includes(b) ? `/usr/local/bin/${b}` : null) });

  test("all five, in order; installed by the chat rule; seenAt from hosts-seen", () => {
    mkdirSync(join(home, "hosts-seen"));
    writeFileSync(join(home, "hosts-seen", "claude"), "");
    const when = new Date("2026-10-14T19:40:00.000Z");
    utimesSync(join(home, "hosts-seen", "claude"), when, when);
    const agents = brainView(home, onPath("claude", "agy")).agents;
    expect(agents).toEqual([
      { family: "claude", installed: true, seenAt: when.toISOString() },
      { family: "codex", installed: false, seenAt: null },
      { family: "agy", installed: true, seenAt: null },
      { family: "qoder", installed: false, seenAt: null },
      { family: "codebuddy", installed: false, seenAt: null },
    ]);
  });

  test("two seen at once: both carry a time (several can be building)", () => {
    mkdirSync(join(home, "hosts-seen"));
    writeFileSync(join(home, "hosts-seen", "codex"), "");
    writeFileSync(join(home, "hosts-seen", "qoder"), "");
    const seen = brainView(home, onPath()).agents.filter((a) => a.seenAt !== null);
    expect(seen.map((a) => a.family)).toEqual(["codex", "qoder"]);
  });
});
