import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMemoryFiles,
  generateFromMemory,
  generateSoulFromQuiz,
  scoreQuiz,
  archetypeOf,
  randomName,
  applyMatchMode,
  dialPolarity,
  QUIZ_LIKERT_ITEMS,
  QUIZ_FINALE,
  type QuizAnswers,
} from "../../src/installer/personality-seed";
import { BrainError } from "../../src/brain/brain";

let tmp: string;
let claudeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-seed-"));
  claudeHome = join(tmp, ".claude");
  mkdirSync(join(claudeHome, "memory"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- findMemoryFiles ----------

test("findMemoryFiles: empty when memory dir missing", async () => {
  rmSync(join(claudeHome, "memory"), { recursive: true });
  expect(await findMemoryFiles(claudeHome)).toEqual([]);
});

test("findMemoryFiles: walks dir + caps count", async () => {
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(claudeHome, "memory", `m${i}.md`), `content ${i}`);
  }
  const files = await findMemoryFiles(claudeHome, { maxFiles: 3 });
  expect(files).toHaveLength(3);
});

test("findMemoryFiles: skips files over maxBytes", async () => {
  writeFileSync(join(claudeHome, "memory", "small.md"), "tiny");
  writeFileSync(join(claudeHome, "memory", "big.md"), "x".repeat(200_000));
  const files = await findMemoryFiles(claudeHome, { maxBytes: 1000 });
  expect(files.map((p) => p.split("/").pop())).toEqual(["small.md"]);
});

test("findMemoryFiles: includes ~/.claude/CLAUDE.md when present", async () => {
  rmSync(join(claudeHome, "memory"), { recursive: true });
  writeFileSync(join(claudeHome, "CLAUDE.md"), "user global prefs");
  const files = await findMemoryFiles(claudeHome);
  expect(files.map((p) => p.split("/").pop())).toEqual(["CLAUDE.md"]);
});

test("findMemoryFiles: does NOT walk ~/.claude/projects/*/memory/", async () => {
  const projDir = join(claudeHome, "projects", "-some-project", "memory");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "leak.md"), "this should NOT leak in");
  rmSync(join(claudeHome, "memory"), { recursive: true });
  const files = await findMemoryFiles(claudeHome);
  expect(files).toEqual([]);
});

test("findMemoryFiles: expands @<file> references inside CLAUDE.md", async () => {
  rmSync(join(claudeHome, "memory"), { recursive: true });
  writeFileSync(join(claudeHome, "CLAUDE.md"), "@RTK.md\n@deeper.md");
  writeFileSync(join(claudeHome, "RTK.md"), "real RTK content");
  writeFileSync(join(claudeHome, "deeper.md"), "another reference");
  const files = await findMemoryFiles(claudeHome);
  const names = files.map((p) => p.split("/").pop());
  expect(names).toContain("CLAUDE.md");
  expect(names).toContain("RTK.md");
  expect(names).toContain("deeper.md");
});

test("findMemoryFiles: walks ~/.claude/rules/ when present", async () => {
  rmSync(join(claudeHome, "memory"), { recursive: true });
  mkdirSync(join(claudeHome, "rules", "common"), { recursive: true });
  writeFileSync(join(claudeHome, "rules", "common", "style.md"), "user style");
  writeFileSync(join(claudeHome, "rules", "common", "test.md"), "user testing");
  const files = await findMemoryFiles(claudeHome);
  const names = files.map((p) => p.split("/").pop()).sort();
  expect(names).toEqual(["style.md", "test.md"]);
});

// ---------- generateFromMemory ----------

test("generateFromMemory: returns null when no files", async () => {
  const r = await generateFromMemory({
    memoryFiles: [],
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
  });
  expect(r).toBeNull();
});

test("generateFromMemory: happy path with fake brain (5-dial schema)", async () => {
  const memPath = join(claudeHome, "memory", "m.md");
  writeFileSync(memPath, "User prefers terse feedback.");
  const r = await generateFromMemory({
    memoryFiles: [memPath],
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
    now: () => new Date("2026-05-14T12:00:00Z"),
    brainFn: async () => ({
      output: {
        snark: 7,
        patience: 4,
        rigor: 6,
        chattiness: 3,
        curiosity: 8,
        soul: "Sassy little cat with a sharp eye for bad joins.",
      } as unknown as never,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  expect(r).not.toBeNull();
  expect(r?.snark).toBe(7);
  expect(r?.patience).toBe(4);
  expect(r?.rigor).toBe(6);
  expect(r?.chattiness).toBe(3);
  expect(r?.curiosity).toBe(8);
});

test("generateFromMemory: returns null when Brain throws BrainError", async () => {
  const memPath = join(claudeHome, "memory", "m.md");
  writeFileSync(memPath, "x");
  const r = await generateFromMemory({
    memoryFiles: [memPath],
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
    brainFn: async () => {
      throw new BrainError("upstream rate limit");
    },
  });
  expect(r).toBeNull();
});

test("generateFromMemory: returns null when output fails schema", async () => {
  const memPath = join(claudeHome, "memory", "m.md");
  writeFileSync(memPath, "x");
  const r = await generateFromMemory({
    memoryFiles: [memPath],
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
    brainFn: async () => ({
      output: {
        snark: 99, // out of range
        patience: 4,
        rigor: 6,
        chattiness: 3,
        curiosity: 8,
        soul: "x",
      } as unknown as never,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  expect(r).toBeNull();
});

// ---------- scoreQuiz (pure function) ----------

function neutralAnswers(): QuizAnswers {
  return {
    likert: QUIZ_LIKERT_ITEMS.map((_, i) => ({
      itemIndex: i,
      score: 3 as const,
    })),
    finale: { letter: "b" as const }, // mild option
  };
}

test("scoreQuiz: all neutral Likert + mild finale stays near 5/5/5/5/5", () => {
  const dials = scoreQuiz(neutralAnswers());
  // every dial should be 4-6 (neutral mid; finale 'b' nudges patience +1, snark -1)
  for (const k of ["snark", "patience", "rigor", "chattiness", "curiosity"] as const) {
    expect(dials[k]).toBeGreaterThanOrEqual(3);
    expect(dials[k]).toBeLessThanOrEqual(7);
  }
});

test("scoreQuiz: max-snark answers push snark high + patience low", () => {
  const dials = scoreQuiz({
    likert: [
      { itemIndex: 0, score: 5 }, // 'sharp than sweet' → snark+ only
      { itemIndex: 1, score: 1 }, // 'let small things slide' strongly disagree → patience-
      { itemIndex: 2, score: 3 },
      { itemIndex: 3, score: 3 },
      { itemIndex: 4, score: 3 },
    ],
    finale: { letter: "a" }, // haiku roast → snark+, rigor+, chattiness+
  });
  expect(dials.snark).toBeGreaterThan(6);
  expect(dials.patience).toBeLessThan(5);
});

test("scoreQuiz: reverse-scored item flips its sign", () => {
  // Item 4 (curiosity:+2, reverse=true) — "I stop looking once I find a way".
  // Strongly agree (5) with reverse=true → flips → curiosity decreases.
  const withAgree = scoreQuiz({
    likert: [
      { itemIndex: 0, score: 3 },
      { itemIndex: 1, score: 3 },
      { itemIndex: 2, score: 3 },
      { itemIndex: 3, score: 3 },
      { itemIndex: 4, score: 5 },
    ],
    finale: { letter: "b" },
  });
  const withDisagree = scoreQuiz({
    likert: [
      { itemIndex: 0, score: 3 },
      { itemIndex: 1, score: 3 },
      { itemIndex: 2, score: 3 },
      { itemIndex: 3, score: 3 },
      { itemIndex: 4, score: 1 },
    ],
    finale: { letter: "b" },
  });
  expect(withAgree.curiosity).toBeLessThan(withDisagree.curiosity);
});

test("scoreQuiz: clips to [0, 10] range", () => {
  // All max-impact answers
  const dials = scoreQuiz({
    likert: QUIZ_LIKERT_ITEMS.map((_, i) => ({
      itemIndex: i,
      score: 5 as const,
    })),
    finale: { letter: "c" },
  });
  for (const k of ["snark", "patience", "rigor", "chattiness", "curiosity"] as const) {
    expect(dials[k]).toBeGreaterThanOrEqual(0);
    expect(dials[k]).toBeLessThanOrEqual(10);
  }
});

// ---------- archetypeOf ----------

test("archetypeOf: high snark + low patience + high rigor + low chattiness = The Hawk", () => {
  const a = archetypeOf({
    snark: 8, patience: 2, rigor: 8, chattiness: 2, curiosity: 5,
  });
  expect(a).toBe("The Hawk");
});

test("archetypeOf: low snark + high patience + high rigor + high chattiness = The Saint", () => {
  const a = archetypeOf({
    snark: 2, patience: 8, rigor: 8, chattiness: 8, curiosity: 5,
  });
  expect(a).toBe("The Saint");
});

test("archetypeOf: curiosity high adds 'Curious' prefix", () => {
  const a = archetypeOf({
    snark: 8, patience: 2, rigor: 8, chattiness: 2, curiosity: 9,
  });
  expect(a).toBe("Curious The Hawk");
});

test("archetypeOf: curiosity low adds 'Steady' prefix", () => {
  const a = archetypeOf({
    snark: 8, patience: 2, rigor: 8, chattiness: 2, curiosity: 1,
  });
  expect(a).toBe("Steady The Hawk");
});

// ---------- randomName ----------

test("randomName: returns sentence-case single word (first upper, rest lower)", () => {
  const name = randomName();
  expect(name).not.toContain(" ");
  // First char upper
  expect(name[0]).toBe(name[0]?.toUpperCase());
  // No uppercase past index 0
  expect(name.slice(1)).toBe(name.slice(1).toLowerCase());
  expect(name.length).toBeGreaterThan(4);
});

test("randomName: deterministic with seeded rng", () => {
  let i = 0;
  const seq = [0.0, 0.0, 0.0]; // pick first adj; force species pool; pick first species-noun
  const rng = () => seq[i++ % seq.length]!;
  const name = randomName("cat", rng);
  expect(name).not.toContain(" ");
});

// ---------- generateSoulFromQuiz ----------

test("generateSoulFromQuiz: happy path returns soul + rationale", async () => {
  const r = await generateSoulFromQuiz({
    answers: neutralAnswers(),
    dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
    brainFn: async () => ({
      output: {
        soul: "Calm cat with no strong opinions.",
        rationale: {
          snark: "Neutral on 'right vs nice'.",
          patience: "Picked option b (polite sticky note).",
        },
      } as unknown as never,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });
  expect(r).not.toBeNull();
  expect(r?.soul).toContain("cat");
  expect(r?.rationale?.snark).toBeTruthy();
});

test("generateSoulFromQuiz: returns null when Brain fails", async () => {
  const r = await generateSoulFromQuiz({
    answers: neutralAnswers(),
    dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
    userPickedName: "Mochi",
    userPickedSpecies: "cat",
    brainFn: async () => {
      throw new BrainError("rate limit");
    },
  });
  expect(r).toBeNull();
});

// ---------- quiz item shape sanity ----------

test("QUIZ_LIKERT_ITEMS: 5 items, all have text + impact", () => {
  expect(QUIZ_LIKERT_ITEMS).toHaveLength(5);
  for (const item of QUIZ_LIKERT_ITEMS) {
    expect(item.text.length).toBeGreaterThan(0);
    expect(Object.keys(item.impact).length).toBeGreaterThan(0);
  }
});

test("QUIZ_FINALE: 4 options, each lettered a/b/c/d", () => {
  expect(QUIZ_FINALE.options).toHaveLength(4);
  expect(QUIZ_FINALE.options.map((o) => o.letter)).toEqual(["a", "b", "c", "d"]);
});

// ---------- matchMode ----------

test("dialPolarity: mirror = +1 for all dials", () => {
  expect(dialPolarity("snark", "mirror")).toBe(1);
  expect(dialPolarity("rigor", "mirror")).toBe(1);
  expect(dialPolarity("curiosity", "mirror")).toBe(1);
});

test("dialPolarity: complement = -1 for all dials", () => {
  expect(dialPolarity("snark", "complement")).toBe(-1);
  expect(dialPolarity("rigor", "complement")).toBe(-1);
  expect(dialPolarity("curiosity", "complement")).toBe(-1);
});

test("dialPolarity: hybrid = mirror for vibe, complement for task", () => {
  expect(dialPolarity("snark", "hybrid")).toBe(1); // vibe → mirror
  expect(dialPolarity("chattiness", "hybrid")).toBe(1); // vibe → mirror
  expect(dialPolarity("rigor", "hybrid")).toBe(-1); // task → complement
  expect(dialPolarity("patience", "hybrid")).toBe(-1); // task → complement
  expect(dialPolarity("curiosity", "hybrid")).toBe(-1); // task → complement
});

test("applyMatchMode: mirror is identity", () => {
  const d = { snark: 7, patience: 3, rigor: 8, chattiness: 4, curiosity: 9 };
  expect(applyMatchMode(d, "mirror")).toEqual(d);
});

test("applyMatchMode: complement flips every dial (10 - v)", () => {
  const result = applyMatchMode(
    { snark: 7, patience: 3, rigor: 8, chattiness: 4, curiosity: 9 },
    "complement",
  );
  expect(result).toEqual({
    snark: 3, patience: 7, rigor: 2, chattiness: 6, curiosity: 1,
  });
});

test("applyMatchMode: hybrid keeps vibe dials, flips task dials", () => {
  const result = applyMatchMode(
    { snark: 7, patience: 3, rigor: 8, chattiness: 4, curiosity: 9 },
    "hybrid",
  );
  expect(result.snark).toBe(7); // vibe — mirror
  expect(result.chattiness).toBe(4); // vibe — mirror
  expect(result.patience).toBe(7); // task — flipped
  expect(result.rigor).toBe(2); // task — flipped
  expect(result.curiosity).toBe(1); // task — flipped
});

test("scoreQuiz: complement mode flips snark direction", () => {
  // User strongly agrees with "I'd rather be sharp than sweet" (snark+ only)
  const answers: QuizAnswers = {
    likert: [
      { itemIndex: 0, score: 5 }, // snark+
      { itemIndex: 1, score: 3 },
      { itemIndex: 2, score: 3 },
      { itemIndex: 3, score: 3 },
      { itemIndex: 4, score: 3 },
    ],
    finale: { letter: "b" },
  };
  const mirror = scoreQuiz(answers, "mirror");
  const complement = scoreQuiz(answers, "complement");
  // user revealed high snark → mirror keeps snark high, complement pulls it low
  expect(complement.snark).toBeLessThan(mirror.snark);
});

test("scoreQuiz: hybrid flips task but keeps vibe", () => {
  // User strongly disagrees with "I stop looking once I find a way" (reverse-
  // scored curiosity item → mirror pushes curiosity UP because they keep
  // looking for alternatives).
  const answers: QuizAnswers = {
    likert: [
      { itemIndex: 0, score: 5 }, // snark+ (vibe)
      { itemIndex: 1, score: 3 },
      { itemIndex: 2, score: 3 },
      { itemIndex: 3, score: 3 },
      { itemIndex: 4, score: 1 }, // reverse → user values curiosity → mirror pushes curiosity up
    ],
    finale: { letter: "b" },
  };
  const mirror = scoreQuiz(answers, "mirror");
  const hybrid = scoreQuiz(answers, "hybrid");
  expect(hybrid.snark).toBe(mirror.snark); // vibe → mirror in both
  expect(hybrid.curiosity).not.toBe(mirror.curiosity); // task → flipped in hybrid
});
