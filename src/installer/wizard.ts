// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { realTtyReadLine } from "./tty-io";

export interface WizardIO {
  readLine(): Promise<string>;
  write(s: string): void;
}

const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

export function realWizardIO(): WizardIO {
  // readLine reads from /dev/tty when interactive so the wizard survives
  // `bun run setup` (its subshell breaks Bun.stdin/process.stdin). See
  // ./tty-io.ts for the full root cause.
  const readLine = realTtyReadLine();
  return {
    readLine,
    write(s: string) {
      process.stdout.write(s);
    },
  };
}

function prompt(question: string, suffix: string): string {
  return `${ANSI_CYAN}? ${question} ${suffix}${ANSI_RESET} `;
}

export interface YesNoOptions {
  default: "yes" | "no";
}

export async function askYesNo(
  io: WizardIO,
  question: string,
  opts: YesNoOptions = { default: "no" },
): Promise<boolean> {
  const hint = opts.default === "yes" ? "[Y/n]" : "[y/N]";
  io.write(prompt(question, hint));
  const raw = (await io.readLine()).trim().toLowerCase();
  if (raw === "") return opts.default === "yes";
  if (raw === "y" || raw === "yes") return true;
  if (raw === "n" || raw === "no") return false;
  return opts.default === "yes";
}

export async function askText(
  io: WizardIO,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const hint = defaultValue ? `[${defaultValue}]` : "";
  io.write(prompt(question, hint));
  const raw = (await io.readLine()).trim();
  if (raw === "") return defaultValue ?? "";
  return raw;
}

function parseChoice<T extends string>(
  raw: string,
  choices: readonly T[],
): T | undefined {
  const asIndex = parseInt(raw, 10);
  if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
    return choices[asIndex - 1];
  }
  return choices.find((c) => c === raw);
}

export async function askChoice<T extends string>(
  io: WizardIO,
  question: string,
  choices: readonly T[],
  defaultValue?: T,
): Promise<T> {
  if (choices.some((c) => c === "y" || c === "Y")) {
    throw new Error("choice value 'y'/'Y' collides with the --yes accept-default sentinel");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = choices
      .map((c, i) => `  ${i + 1}) ${c}${defaultValue === c ? " *" : ""}`)
      .join("\n");
    io.write(`${ANSI_CYAN}? ${question}${ANSI_RESET}\n${list}\n`);
    io.write(
      prompt(`choose (1-${choices.length})`, defaultValue ? `[${defaultValue}]` : ""),
    );
    const raw = (await io.readLine()).trim();
    // "" (blank Enter) or the bare "y" sentinel (used by --yes / autoYesIo, which
    // isn't prompt-type-aware) both mean "accept the default" here.
    if ((raw === "" || raw.toLowerCase() === "y") && defaultValue) return defaultValue;
    const parsed = parseChoice(raw, choices);
    if (parsed) return parsed;
    io.write(`${ANSI_CYAN}  (invalid choice, try again)${ANSI_RESET}\n`);
  }
  const fallback = defaultValue ?? choices[0];
  if (fallback) return fallback;
  throw new Error("askChoice requires at least one choice");
}

export interface LabeledChoice<T extends string> {
  value: T;
  label: string;
}

export async function askLabeledChoice<T extends string>(
  io: WizardIO,
  question: string,
  choices: readonly LabeledChoice<T>[],
  defaultValue?: T,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = choices
      .map(
        (c, i) =>
          `  ${i + 1}) ${c.label}${defaultValue === c.value ? " *" : ""}`,
      )
      .join("\n");
    io.write(`${ANSI_CYAN}? ${question}${ANSI_RESET}\n${list}\n`);
    io.write(
      prompt(
        `choose (1-${choices.length})`,
        defaultValue ? `[${defaultValue}]` : "",
      ),
    );
    const raw = (await io.readLine()).trim();
    if (raw === "" && defaultValue) return defaultValue;
    const asIndex = parseInt(raw, 10);
    if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
      return choices[asIndex - 1]?.value;
    }
    const direct = choices.find((c) => c.value === raw);
    if (direct) return direct.value;
    io.write(`${ANSI_CYAN}  (invalid choice, try again)${ANSI_RESET}\n`);
  }
  return defaultValue ?? choices[0]?.value;
}

function parseLabeledMultiChoice<T extends string>(
  raw: string,
  choices: readonly LabeledChoice<T>[],
): T[] | null {
  const selected: T[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const asIndex = parseInt(part, 10);
    const value =
      Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= choices.length
        ? choices[asIndex - 1]?.value
        : choices.find((c) => c.value === part)?.value;
    if (!value) return null;
    if (!selected.includes(value)) selected.push(value);
  }
  return selected.length > 0 ? selected : null;
}

export async function askLabeledMultiChoice<T extends string>(
  io: WizardIO,
  question: string,
  choices: readonly LabeledChoice<T>[],
  defaultValues: readonly T[],
): Promise<T[]> {
  if (choices.some((c) => c.value === "y" || c.value === "Y")) {
    throw new Error("choice value 'y'/'Y' collides with the --yes accept-default sentinel");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = choices
      .map((c, i) => {
        const selected = defaultValues.includes(c.value) ? "x" : " ";
        return `  ${i + 1}) [${selected}] ${c.label}`;
      })
      .join("\n");
    io.write(`${ANSI_CYAN}? ${question}${ANSI_RESET}\n${list}\n`);
    const defaultIndices = choices
      .map((c, i) => (defaultValues.includes(c.value) ? String(i + 1) : ""))
      .filter(Boolean)
      .join(",");
    io.write(
      prompt(
        "choose one or more (comma-separated)",
        defaultIndices ? `[${defaultIndices}]` : "",
      ),
    );
    const raw = (await io.readLine()).trim();
    // "" (blank Enter) or the bare "y" sentinel (used by --yes / autoYesIo, which
    // isn't prompt-type-aware) both mean "accept the defaults" here.
    if ((raw === "" || raw.toLowerCase() === "y") && defaultValues.length > 0) return [...defaultValues];

    const selected = parseLabeledMultiChoice(raw, choices);
    if (selected) return selected;
    io.write(`${ANSI_CYAN}  (invalid selection, try again)${ANSI_RESET}\n`);
  }
  return [...defaultValues];
}

export async function askNumber(
  io: WizardIO,
  question: string,
  opts: { min: number; max: number; default: number },
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    io.write(
      prompt(question, `[${opts.default}, range ${opts.min}-${opts.max}]`),
    );
    const raw = (await io.readLine()).trim();
    if (raw === "") return opts.default;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= opts.min && n <= opts.max) return n;
    io.write(
      `${ANSI_CYAN}  (must be an integer ${opts.min}-${opts.max})${ANSI_RESET}\n`,
    );
  }
  return opts.default;
}
