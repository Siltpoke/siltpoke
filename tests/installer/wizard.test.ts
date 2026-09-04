import { test, expect } from "bun:test";
import {
  askYesNo,
  askText,
  askChoice,
  askLabeledMultiChoice,
  type WizardIO,
} from "../../src/installer/wizard";

function fakeIO(answers: string[]): WizardIO & { output: string[] } {
  let i = 0;
  const output: string[] = [];
  return {
    output,
    async readLine(): Promise<string> {
      return answers[i++] ?? "";
    },
    write(s: string) {
      output.push(s);
    },
  };
}

test("askYesNo: empty input → default yes", async () => {
  const io = fakeIO([""]);
  expect(await askYesNo(io, "ok?", { default: "yes" })).toBe(true);
});

test("askYesNo: empty input → default no", async () => {
  const io = fakeIO([""]);
  expect(await askYesNo(io, "ok?", { default: "no" })).toBe(false);
});

test("askYesNo: y / yes returns true", async () => {
  expect(await askYesNo(fakeIO(["y"]), "ok?")).toBe(true);
  expect(await askYesNo(fakeIO(["YES"]), "ok?")).toBe(true);
});

test("askYesNo: n returns false even with default yes", async () => {
  expect(await askYesNo(fakeIO(["n"]), "ok?", { default: "yes" })).toBe(false);
});

test("askText: empty input → default", async () => {
  const got = await askText(fakeIO([""]), "name?", "Siltpoke");
  expect(got).toBe("Siltpoke");
});

test("askText: trims surrounding whitespace", async () => {
  const got = await askText(fakeIO(["  Mochi  "]), "name?", "Siltpoke");
  expect(got).toBe("Mochi");
});

test("askChoice: numeric pick from list", async () => {
  const choices = ["cat", "slime", "owl"] as const;
  const got = await askChoice(fakeIO(["2"]), "species?", choices);
  expect(got).toBe("slime");
});

test("askChoice: direct name pick", async () => {
  const choices = ["cat", "slime", "owl"] as const;
  const got = await askChoice(fakeIO(["owl"]), "species?", choices);
  expect(got).toBe("owl");
});

test("askChoice: empty input → default", async () => {
  const choices = ["cat", "slime", "owl"] as const;
  const got = await askChoice(fakeIO([""]), "species?", choices, "owl");
  expect(got).toBe("owl");
});

test("askChoice: invalid then valid", async () => {
  const choices = ["cat", "slime", "owl"] as const;
  const io = fakeIO(["banana", "2"]);
  const got = await askChoice(io, "species?", choices);
  expect(got).toBe("slime");
});

test("askChoice: 3 invalid attempts → fall back to default", async () => {
  const choices = ["cat", "slime", "owl"] as const;
  const io = fakeIO(["x", "y", "z"]);
  const got = await askChoice(io, "species?", choices, "cat");
  expect(got).toBe("cat");
});

test("ANSI cyan prefix present in prompts", async () => {
  const io = fakeIO(["y"]);
  await askYesNo(io, "ok?");
  expect(io.output.join("")).toContain("\x1b[36m");
});

test("askLabeledMultiChoice: select multiple by index", async () => {
  const choices = [
    { value: "claude-code", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ] as const;
  const got = await askLabeledMultiChoice(
    fakeIO(["1, 2"]),
    "agents?",
    choices,
    ["claude-code"],
  );
  expect(got).toEqual(["claude-code", "codex"]);
});

test("askLabeledMultiChoice: empty input uses defaults", async () => {
  const choices = [
    { value: "claude-code", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ] as const;
  const got = await askLabeledMultiChoice(
    fakeIO([""]),
    "agents?",
    choices,
    ["claude-code"],
  );
  expect(got).toEqual(["claude-code"]);
});

test("askChoice: choice value 'y' collides with --yes sentinel", async () => {
  const choices = ["y", "no", "maybe"] as const;
  const io = fakeIO([]);
  await expect(askChoice(io, "proceed?", choices)).rejects.toThrow(
    "choice value 'y'/'Y' collides with the --yes accept-default sentinel",
  );
});

test("askLabeledMultiChoice: choice value 'Y' collides with --yes sentinel", async () => {
  const choices = [
    { value: "Y" as const, label: "Yes" },
    { value: "N" as const, label: "No" },
  ];
  const io = fakeIO([]);
  await expect(askLabeledMultiChoice(io, "proceed?", choices, [])).rejects.toThrow(
    "choice value 'y'/'Y' collides with the --yes accept-default sentinel",
  );
});
