/**
 * Compat shim tests.
 *
 * Verify readMemory / writeMemory transparently bridge v2-shaped CoreMemory
 * over a v3 two-store layout. All pre-split callers go through this seam.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd as getCwd } from "node:process";
import {
  readMemory,
  writeMemory,
  emptyMemory,
  type CoreMemory,
} from "../../src/memory/memory";
import {
  readGlobal,
  writeGlobal,
  emptyGlobal,
} from "../../src/memory/global";
import {
  readProject,
  writeProject,
  emptyProject,
  resolveProjectRoot,
  projectMemoryPath,
} from "../../src/memory/project";

let home: string;
let projectCwdSrc: string;
let projectCwd: string; // canonical path after chdir (handles /var → /private/var)
let prevCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-shim-home-"));
  projectCwdSrc = mkdtempSync(join(tmpdir(), "siltpoke-shim-cwd-"));
  mkdirSync(join(projectCwdSrc, ".git"));
  prevCwd = getCwd();
  chdir(projectCwdSrc);
  projectCwd = getCwd(); // realpath-canonicalized path used by shim
});

afterEach(() => {
  chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(projectCwdSrc, { recursive: true, force: true });
});

describe("readMemory v3-aware shim", () => {
  test("returns null on pristine home (no v2, no v3)", async () => {
    expect(await readMemory(home)).toBeNull();
  });

  test("returns v2 unchanged on v2-only home", async () => {
    const v2: CoreMemory = {
      ...emptyMemory(),
      long_term_summary: "v2 data here",
    };
    await writeMemory(home, v2);
    const back = await readMemory(home);
    expect(back!.long_term_summary).toBe("v2 data here");
    expect(existsSync(join(home, "memory.json"))).toBe(true);
    expect(existsSync(join(home, "global.json"))).toBe(false);
  });

  test("merges global + per-project on v3 layout", async () => {
    const resolved = resolveProjectRoot(projectCwd);
    const g = emptyGlobal();
    g.user_profile.name = "alex";
    g.user_profile.communication_style = "terse";
    await writeGlobal(home, g);

    const p = emptyProject(resolved);
    p.long_term_summary = "the summary";
    p.facts.push({
      id: "f-1",
      text: "user prefers tabs",
      source_session_id: null,
      confidence: 0.9,
      status: "active",
      created_at: "2026-05-16T00:00:00Z",
      last_seen_at: "2026-05-16T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
    });
    p.personality_drift = {
      snark: 2,
      patience: -1,
      style_strictness: 1,
      proactivity: 0,
      curiosity: 3,
    };
    await writeProject(home, resolved.project_id, p);

    const m = await readMemory(home);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(2);
    expect(m!.user_profile.name).toBe("alex");
    expect(m!.user_profile.communication_style).toBe("terse");
    expect(m!.long_term_summary).toBe("the summary");
    expect(m!.facts).toHaveLength(1);
    // v2 drift never sees curiosity (it's stripped during merge).
    expect(Object.keys(m!.personality_drift)).toEqual([
      "snark",
      "patience",
      "style_strictness",
      "proactivity",
    ]);
    expect(m!.personality_drift.snark).toBe(2);
  });

  test("per-project communication_style override beats global", async () => {
    const resolved = resolveProjectRoot(projectCwd);
    const g = emptyGlobal();
    g.user_profile.communication_style = "neutral";
    await writeGlobal(home, g);
    const p = emptyProject(resolved);
    p.user_profile_override.communication_style = "playful";
    await writeProject(home, resolved.project_id, p);
    const m = await readMemory(home);
    expect(m!.user_profile.communication_style).toBe("playful");
  });

  test("null per-project override falls back to global communication_style", async () => {
    const resolved = resolveProjectRoot(projectCwd);
    const g = emptyGlobal();
    g.user_profile.communication_style = "verbose";
    await writeGlobal(home, g);
    await writeProject(home, resolved.project_id, emptyProject(resolved));
    const m = await readMemory(home);
    expect(m!.user_profile.communication_style).toBe("verbose");
  });
});

describe("writeMemory v3-aware shim", () => {
  test("writes v2 file on v2-only home (no global.json)", async () => {
    const v2 = emptyMemory();
    v2.long_term_summary = "v2 path";
    await writeMemory(home, v2);
    expect(existsSync(join(home, "memory.json"))).toBe(true);
    expect(existsSync(join(home, "global.json"))).toBe(false);
  });

  test("splits into global + project on v3 home", async () => {
    // Seed v3 layout (just global.json triggers the shim path).
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectCwd);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    const v2: CoreMemory = {
      ...emptyMemory(),
      long_term_summary: "split target",
      user_profile: {
        ...emptyMemory().user_profile,
        name: "vic",
        communication_style: "terse",
        goals: [
          { id: "g-1", text: "ship", created_at: "2026-05-16T00:00:00Z", status: "active" },
        ],
        constraints: ["no force-push"],
        prefs: { tabWidth: 4 },
      },
      facts: [
        {
          id: "f-1",
          text: "fact a",
          source_session_id: null,
          confidence: 0.9,
          status: "active",
          created_at: "2026-05-16T00:00:00Z",
          last_seen_at: "2026-05-16T00:00:00Z",
          supersedes: null,
          superseded_by: null,
          pinned: false,
          recall_count: 0,
          retired_reason: null,
          stability: "durable",
          learned_from: null,
          last_confirmed_at: null,
          expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
        },
      ],
    };
    await writeMemory(home, v2);

    // No v2 file appears — writes went to v3.
    expect(existsSync(join(home, "memory.json"))).toBe(false);

    const g = await readGlobal(home);
    expect(g!.user_profile.name).toBe("vic");
    expect(g!.user_profile.communication_style).toBe("terse");

    const p = await readProject(home, resolved.project_id);
    expect(p!.long_term_summary).toBe("split target");
    expect(p!.facts).toHaveLength(1);
    expect(p!.user_profile_override.goals).toHaveLength(1);
    expect(p!.user_profile_override.constraints).toEqual(["no force-push"]);
    expect(p!.user_profile_override.prefs).toEqual({ tabWidth: 4 });
  });

  test("preserves v3-only global fields when shim writes", async () => {
    const g = emptyGlobal();
    g.xp_total = 42;
    g.xp_log.push({
      id: "xp-1",
      ts: "2026-05-16T00:00:00Z",
      amount: 5,
      source: "manual_pet",
      source_id: null,
      source_project: null,
      capped: false,
      note: null,
    });
    g.streak.current_days = 7;
    g.personality_base.snark = 1;
    await writeGlobal(home, g);
    const resolved = resolveProjectRoot(projectCwd);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    const v2 = emptyMemory();
    v2.long_term_summary = "irrelevant to global";
    await writeMemory(home, v2);

    const after = await readGlobal(home);
    expect(after!.xp_total).toBe(42);
    expect(after!.xp_log).toHaveLength(1);
    expect(after!.streak.current_days).toBe(7);
    expect(after!.personality_base.snark).toBe(1);
  });

  test("preserves v3-only project fields (project_id/root/curiosity)", async () => {
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectCwd);
    const p = emptyProject(resolved);
    p.personality_drift.curiosity = 3;
    await writeProject(home, resolved.project_id, p);

    const v2 = emptyMemory();
    v2.personality_drift = {
      snark: 2,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
    };
    await writeMemory(home, v2);

    const back = await readProject(home, resolved.project_id);
    expect(back!.project_id).toBe(resolved.project_id);
    expect(back!.project_root).toBe(resolved.project_root);
    expect(back!.personality_drift.curiosity).toBe(3);
    expect(back!.personality_drift.snark).toBe(2);
  });

  test("round-trip: write → read returns equivalent v2 shape", async () => {
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectCwd);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    const v2: CoreMemory = {
      ...emptyMemory(),
      long_term_summary: "round trip",
      user_profile: {
        ...emptyMemory().user_profile,
        name: "rt",
        communication_style: "verbose",
        goals: [],
        constraints: ["c1", "c2"],
        prefs: { theme: "dark" },
      },
      facts: [
        {
          id: "f-rt",
          text: "round trip fact",
          source_session_id: null,
          confidence: 0.7,
          status: "active",
          created_at: "2026-05-16T00:00:00Z",
          last_seen_at: "2026-05-16T00:00:00Z",
          supersedes: null,
          superseded_by: null,
          pinned: false,
          recall_count: 0,
          retired_reason: null,
          stability: "durable",
          learned_from: null,
          last_confirmed_at: null,
          expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
        },
      ],
    };
    await writeMemory(home, v2);
    const back = await readMemory(home);
    expect(back!.long_term_summary).toBe(v2.long_term_summary);
    expect(back!.user_profile.name).toBe("rt");
    expect(back!.user_profile.communication_style).toBe("verbose");
    expect(back!.user_profile.constraints).toEqual(["c1", "c2"]);
    expect(back!.user_profile.prefs).toEqual({ theme: "dark" });
    expect(back!.facts).toHaveLength(1);
    expect(back!.facts[0]!.id).toBe("f-rt");
  });

  test("cross-project isolation: write in cwd A does not affect cwd B's memory", async () => {
    await writeGlobal(home, emptyGlobal());

    // Two different cwd's = two different project_ids
    const cwdA = mkdtempSync(join(tmpdir(), "siltpoke-shim-cwdA-"));
    const cwdB = mkdtempSync(join(tmpdir(), "siltpoke-shim-cwdB-"));
    mkdirSync(join(cwdA, ".git"));
    mkdirSync(join(cwdB, ".git"));

    try {
      // Resolve AFTER chdir so the project_id we capture matches what the
      // shim will compute (macOS canonicalizes /var → /private/var on chdir;
      // computing project_id from the raw mkdtemp path would mis-match).
      chdir(cwdB);
      const resolvedB = resolveProjectRoot(getCwd());
      const v2B = emptyMemory();
      v2B.long_term_summary = "in B";
      await writeMemory(home, v2B);

      chdir(cwdA);
      const resolvedA = resolveProjectRoot(getCwd());
      expect(resolvedA.project_id).not.toBe(resolvedB.project_id);
      const v2A = emptyMemory();
      v2A.long_term_summary = "in A";
      await writeMemory(home, v2A);

      // Read B back — should still say "in B"
      chdir(cwdB);
      const backB = await readMemory(home);
      expect(backB!.long_term_summary).toBe("in B");

      // Read A — "in A"
      chdir(cwdA);
      const backA = await readMemory(home);
      expect(backA!.long_term_summary).toBe("in A");

      // Assert the shim really wrote to two distinct per-project files.
      expect(existsSync(projectMemoryPath(home, resolvedA.project_id))).toBe(true);
      expect(existsSync(projectMemoryPath(home, resolvedB.project_id))).toBe(true);
    } finally {
      chdir(projectCwd);
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });

  test("legacy memory.json still readable when v3 absent (no shim trigger)", async () => {
    // Make sure the shim never accidentally clobbers a v2-only setup.
    const v2 = emptyMemory();
    v2.facts.push({
      id: "f-l",
      text: "legacy",
      source_session_id: null,
      confidence: 0.5,
      status: "active",
      created_at: "2026-05-16T00:00:00Z",
      last_seen_at: "2026-05-16T00:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
    });
    writeFileSync(join(home, "memory.json"), JSON.stringify(v2));
    const back = await readMemory(home);
    expect(back!.facts).toHaveLength(1);
    expect(back!.facts[0]!.text).toBe("legacy");
  });

  test("schemaVersion is always 2 on merged read (v2 contract)", async () => {
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectCwd);
    await writeProject(home, resolved.project_id, emptyProject(resolved));
    const back = await readMemory(home);
    expect(back!.schemaVersion).toBe(2);
  });
});

describe("readMemory/writeMemory — projectCwd override (per-event-repo scoping)", () => {
  // HIGH finding: the daemon's process.cwd() is frozen at launch, but the
  // Stop-hook critic (and consolidate) must key the V3 project slice off the
  // REPO THAT FIRED THE EVENT (event.cwd), not the daemon's own cwd. This
  // proves the optional `projectCwd` override on readMemory/writeMemory
  // selects the right slice, independent of process.cwd().
  test("projectCwd override selects distinct project slices for distinct repos", async () => {
    await writeGlobal(home, emptyGlobal());
    const repoX = mkdtempSync(join(tmpdir(), "siltpoke-shim-repoX-"));
    const repoY = mkdtempSync(join(tmpdir(), "siltpoke-shim-repoY-"));
    try {
      const resolvedX = resolveProjectRoot(repoX);
      const resolvedY = resolveProjectRoot(repoY);
      // Distinct paths MUST resolve to distinct project_ids for this test to
      // prove anything about slice isolation.
      expect(resolvedX.project_id).not.toBe(resolvedY.project_id);

      const memX: CoreMemory = {
        ...emptyMemory(),
        long_term_summary: "repo X summary",
      };
      await writeMemory(home, memX, repoX);

      const backX = await readMemory(home, repoX);
      expect(backX!.long_term_summary).toBe("repo X summary");

      // A DIFFERENT projectCwd must NOT see repo X's slice.
      const backY = await readMemory(home, repoY);
      expect(backY!.long_term_summary).not.toBe("repo X summary");
    } finally {
      rmSync(repoX, { recursive: true, force: true });
      rmSync(repoY, { recursive: true, force: true });
    }
  });
});

describe("shim end-to-end with pre-split callers", () => {
  test("appendLearnedRule works on v3 layout via shim", async () => {
    const { appendLearnedRule } = await import("../../src/memory/memory");
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectCwd);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    const r = await appendLearnedRule(home, {
      id: "lr-1",
      rule: "test rule",
      category: "test",
      created_at: "2026-05-16T00:00:00Z",
      applied_count: 0,
      effectiveness: "neutral",
    });
    expect(r.appended).toBe(true);

    const back = await readProject(home, resolved.project_id);
    expect(back!.learned_rules).toHaveLength(1);
    expect(back!.learned_rules[0]!.id).toBe("lr-1");
  });
});
