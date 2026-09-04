// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-family brain-provider smoke — REAL subprocess e2e.
 *
 * Spawns the actual review CLI (`bun run src/cli/review.ts`) as a child
 * process with a stub `codex` binary planted on PATH that replays the
 * live-captured happy JSONL (tests/brain/fixtures/codex shapes). Exercises
 * the FULL chain across process boundaries — argv assembly, stdin payload,
 * env inheritance (SILTPOKE_INTERNAL), JSONL parse, zod gate, critique
 * output — with zero network and zero real quota spend. Precedent:
 * tests/cli/index-repo.e2e.test.ts (Bun.spawn, no Playwright).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const CLI = join(REPO, "src/cli/review.ts");

let work: string; // temp workspace: stub bin + fake home + tiny git repo
let stubBin: string;
let home: string;
let project: string;

const BRAIN_JSON = JSON.stringify({
  mood: "happy",
  pose: "base",
  bubble_short: "stub codex says hi",
  bubble_long: "",
  critique_for_claude: "e2e stub critique — chain intact",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
  evidence: [],
});

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "bp-e2e-"));
  stubBin = join(work, "bin");
  home = join(work, "home");
  project = join(work, "project");
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  // Stub codex: asserts it was invoked as `codex exec`, echoes the marker env
  // to a witness file, then replays a happy JSONL stream on stdout.
  const witness = join(work, "codex-witness.txt");
  const agentMessage = JSON.stringify(BRAIN_JSON); // JSON-escaped string form
  writeFileSync(
    join(stubBin, "codex"),
    `#!/bin/sh
cat > /dev/null   # drain stdin (the context bundle)
{ printf 'ARGV %s\\n' "$*"; printf 'INTERNAL %s\\n' "$SILTPOKE_INTERNAL"; } > "${witness}"
printf '%s\\n' '{"type":"thread.started","thread_id":"e2e"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":${agentMessage.replace(/'/g, "'\\''")}}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":40,"reasoning_output_tokens":0}}'
`,
  );
  chmodSync(join(stubBin, "codex"), 0o755);

  // Fake $HOME/.siltpoke with codex configured via config.json (not env —
  // proves the config path end-to-end) and budget wide open. The review CLI
  // resolves homeBase as $HOME/.siltpoke (review.ts:126-127).
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(
    join(home, ".siltpoke", "config.json"),
    JSON.stringify({ reviewer_provider: "codex", budget: { dailyTokenLimit: 0 } }),
  );

  // Tiny git repo with one committed file + one staged-off change to review.
  const sh = (cmd: string) =>
    Bun.spawnSync(["sh", "-c", cmd], { cwd: project, env: { ...process.env } });
  sh("git init -q && git config user.email e2e@test && git config user.name e2e");
  writeFileSync(join(project, "a.ts"), "export const x = 1;\n");
  sh("git add a.ts && git commit -qm init");
  writeFileSync(join(project, "a.ts"), "export const x = 2; // changed\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

test("review CLI e2e: config-selected codex stub produces a real critique across process boundaries", async () => {
  const proc = Bun.spawn(
    ["bun", "run", CLI],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        HOME: home, // review CLI resolves homeBase as $HOME/.siltpoke
        SILTPOKE_REVIEWER_PROVIDER: "", // must NOT be needed — config.json decides
      },
    },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  const combined = out + err;

  expect(exit).toBe(0);
  // The critique from the stub made it through JSONL parse + zod gate + CLI render.
  expect(combined).toContain("stub codex says hi");
  // Warn-once fired for the quota provider.
  expect(combined).toMatch(/quota-billed/);

  // Witness: stub really ran as `codex exec ...` with the recursion marker set.
  const witness = await Bun.file(join(work, "codex-witness.txt")).text();
  expect(witness).toContain("ARGV exec");
  expect(witness).toContain("--json");
  expect(witness).toContain("read-only");
  expect(witness).toContain("INTERNAL 1");
}, 60_000);
