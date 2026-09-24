// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The hook-side wiring. `tests/update/` covers the logic; this file covers the
// part that is easy to ship broken and still green: that SessionStart actually
// emits the thing, in the shape the host reads, and that the nested-session
// guard is really wired rather than merely available.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCommandFor, updateSystemMessage } from "../../src/hooks/handle-session-start";
import { cachePath } from "../../src/update/check";

/** A HOME with a cached "1.3.0 is out" answer. The repo itself supplies the installed version. */
function homeWithUpdate(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "siltpoke-hookupd-"));
  const home = join(root, ".siltpoke");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    cachePath(home),
    JSON.stringify({ checkedAtMs: Date.now(), latestVersion: "999.0.0", headline: "Windows works" }),
  );
  if (extra.config) writeFileSync(join(home, "config.json"), JSON.stringify(extra.config));
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("updateCommandFor", () => {
  test("each host gets the command that host actually understands", () => {
    expect(updateCommandFor({})).toBe("claude plugin update siltpoke");
    expect(updateCommandFor({ SILTPOKE_HOST: "codex" })).toContain("codex plugin update");
    expect(updateCommandFor({ SILTPOKE_HOST: "qoder" })).toContain("qodercli");
    expect(updateCommandFor({ SILTPOKE_HOST: "codebuddy" })).toContain("marketplace update");
    expect(updateCommandFor({ SILTPOKE_HOST: "antigravity" })).toContain("agy plugin install");
  });

  test("an unknown host falls back rather than printing undefined", () => {
    const cmd = updateCommandFor({ SILTPOKE_HOST: "something-new" });
    expect(cmd).toBe("claude plugin update siltpoke");
    expect(cmd).not.toContain("undefined");
  });
});

describe("updateSystemMessage", () => {
  test("emits a systemMessage JSON — the documented user-visible channel", () => {
    const h = homeWithUpdate();
    try {
      const out = updateSystemMessage({ SILTPOKE_HOME: h.home });
      expect(out).not.toBeNull();
      const parsed = JSON.parse(out as string) as Record<string, unknown>;
      // `additionalContext` is model-context-only; using it here would mean the
      // user never sees the notice. The key name IS the feature.
      expect(Object.keys(parsed)).toEqual(["systemMessage"]);
      expect(String(parsed.systemMessage)).toContain("999.0.0");
      expect(String(parsed.systemMessage)).toContain("claude plugin update siltpoke");
    } finally {
      h.cleanup();
    }
  });

  test("the per-host command reaches the sentence", () => {
    const h = homeWithUpdate();
    try {
      const out = updateSystemMessage({ SILTPOKE_HOME: h.home, SILTPOKE_HOST: "qoder" });
      expect(String(JSON.parse(out as string).systemMessage)).toContain("qodercli");
    } finally {
      h.cleanup();
    }
  });

  test("silent inside a nested Brain-call session — there is no user in one", () => {
    const h = homeWithUpdate();
    try {
      // Sanity: it WOULD have spoken without the marker, so this asserts the
      // guard and not merely an unrelated silence.
      expect(updateSystemMessage({ SILTPOKE_HOME: h.home })).not.toBeNull();
      expect(updateSystemMessage({ SILTPOKE_HOME: h.home, SILTPOKE_INTERNAL: "1" })).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("silent when the user turned it off", () => {
    const h = homeWithUpdate({ config: { updateCheck: { enabled: false } } });
    try {
      expect(updateSystemMessage({ SILTPOKE_HOME: h.home })).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("an unusable HOME produces null, never a throw into SessionStart", () => {
    expect(updateSystemMessage({ HOME: "", SILTPOKE_HOME: "" })).toBeNull();
  });
});
