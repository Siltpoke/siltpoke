// Gate step [1], end to end (gate spec 2026-08-20 AC1 / AC8 / AC32): with no
// static tool producing anything, a reviewable change still reaches the AI —
// and the AI is given the diff itself, not a file count.
//
// The 2026-10-22 sandbox shape: a project with no tsconfig, no eslint config,
// ripgrep clean. Before step [1] this was PASSIVE_BUBBLE and the reviewer's
// prompt never contained the code.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCritic } from "../../src/critic/run-critic";
import type { BrainCallResult, CallBrainOptions } from "../../src/brain/brain";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import type { ProjectCapabilities } from "../../src/critic/capabilities";

const SENTINEL = "SENTINEL_7f3a_payments_internal";

const OUTPUT = {
  mood: "watching", pose: "peek", bubble_short: "seen", bubble_long: "",
  critique_for_claude: "", severity: "info", confidence: "medium",
  xp_earned_events: [], evidence: [], findings: [],
} as const;

const na = (tool: ToolName): ToolResult => ({ tool, status: "not_applicable", parsed: [], raw: "" }) as ToolResult;

function caps(cwd: string): ProjectCapabilities {
  return {
    cwd, hasGit: true, hasTsc: false, hasEslint: false, hasRipgrep: false,
    tsconfigPaths: [], eslintConfigPaths: [], detectedAt: Date.now(), configMtimes: {},
  };
}

async function reviewOf(file: string, ripgrep: ToolResult = na("ripgrep")): Promise<{ decision: string; prompts: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "gate-step1-"));
  const home = join(root, "home");
  mkdirSync(join(home, "state"), { recursive: true });
  const prompts: string[] = [];
  const header = "@@ -1,2 +1,3 @@";
  const body = ` export const a = 1;\n+export const b = "${SENTINEL}";\n+export const c = 2;`;
  try {
    const result = await runCritic(
      {
        source: "stop-hook", cwd: root, changedFiles: [file], caps: caps(root), homeBase: home,
        brainContext: {
          personalitySystemPrompt: "You are Siltpoke.", memory: null, recent: [], sessionId: "s1",
          cwd: root, stateBase: join(home, "state"),
        },
      },
      {
        runToolsFn: async () => ({
          tsc: na("tsc"),
          eslint: na("eslint"),
          "git-diff": {
            tool: "git-diff", status: "ok",
            parsed: [{ file, oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, header, body }],
            raw: `diff --git a/${file} b/${file}\n${header}\n${body}`,
          } as ToolResult,
          ripgrep,
          securityFindings: [], owaspHints: [], webSearchSources: [],
        }) as never,
        callBrainFn: async (o: CallBrainOptions): Promise<BrainCallResult> => {
          prompts.push(`${o.systemPrompt}\n${o.contextBundle}`);
          return { output: OUTPUT as never, usage: { input_tokens: 1, output_tokens: 1 } as never };
        },
        writeCritiqueFn: async () => ({ id: "c-gate", path: join(root, "c.md") }),
      },
    );
    return { decision: result.decision, prompts };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("gate step [1]: a reviewable change reaches the AI with its diff", () => {
  test("AC1: only git-diff ran, a .ts change → NORMAL, one Brain call, the hunk is in the prompt", async () => {
    const { decision, prompts } = await reviewOf("src/billing.ts");
    expect(decision).toBe("NORMAL");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("src/billing.ts");
    expect(prompts[0]).toContain("@@ -1,2 +1,3 @@");
    expect(prompts[0]).toContain(`+export const b = "${SENTINEL}";`);
  });

  test("AC2: ripgrep ran clean too → still NORMAL with the hunk", async () => {
    const { decision, prompts } = await reviewOf("src/billing.ts", { tool: "ripgrep", status: "ok", parsed: [], raw: "" } as ToolResult);
    expect(decision).toBe("NORMAL");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SENTINEL);
  });

  test("AC8: a shell script is reviewed", async () => {
    const { decision, prompts } = await reviewOf("deploy.sh");
    expect(decision).toBe("NORMAL");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SENTINEL);
  });

  test("AC25: a hook script under .claude/ is reviewed (exclusion is by extension, not directory)", async () => {
    const { decision, prompts } = await reviewOf(".claude/hooks/stop.sh");
    expect(decision).toBe("NORMAL");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SENTINEL);
  });

  test("AC32: a Ruby file in a repo with no linter is reviewed", async () => {
    const { decision, prompts } = await reviewOf("app/models/user.rb");
    expect(decision).toBe("NORMAL");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SENTINEL);
  });

  test("paired exclusion: a docs-only change does NOT reach NORMAL and the prompt has no diff", async () => {
    const { decision, prompts } = await reviewOf("docs/guide.md");
    expect(decision).toBe("PASSIVE_BUBBLE");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(SENTINEL);
  });
});
