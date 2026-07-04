// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface WizardIO {
  readLine(): Promise<string>;
  write(s: string): void;
}

const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

export function realWizardIO(): WizardIO {
  let buffer = "";
  let exhausted = false;
  const decoder = new TextDecoder();
  const reader = (Bun.stdin as unknown as { stream: () => ReadableStream<Uint8Array> })
    .stream()
    .getReader();
  return {
    async readLine(): Promise<string> {
      while (!exhausted) {
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return line;
        }
        const { done, value } = await reader.read();
        if (done) {
          exhausted = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
      }
      const line = buffer;
      buffer = "";
      return line;
    },
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

export async function askChoice<T extends string>(
  io: WizardIO,
  question: string,
  choices: readonly T[],
  defaultValue?: T,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = choices
      .map((c, i) => `  ${i + 1}) ${c}${defaultValue === c ? " *" : ""}`)
      .join("\n");
    io.write(`${ANSI_CYAN}? ${question}${ANSI_RESET}\n${list}\n`);
    io.write(
      prompt(`choose (1-${choices.length})`, defaultValue ? `[${defaultValue}]` : ""),
    );
    const raw = (await io.readLine()).trim();
    if (raw === "" && defaultValue) return defaultValue;
    const asIndex = parseInt(raw, 10);
    if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
      return choices[asIndex - 1]!;
    }
    const direct = choices.find((c) => c === raw);
    if (direct) return direct;
    io.write(`${ANSI_CYAN}  (invalid choice, try again)${ANSI_RESET}\n`);
  }
  return defaultValue ?? choices[0]!;
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
