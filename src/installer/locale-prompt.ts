// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { WizardIO } from "./wizard";
import { askLabeledChoice } from "./wizard";
import type { Locale } from "./i18n";

export async function askLocale(
  io: WizardIO,
  opts: { yes?: boolean; default?: Locale } = {},
): Promise<Locale> {
  const fallback = opts.default ?? "en";
  if (opts.yes) return fallback;
  return askLabeledChoice<Locale>(
    io,
    "Language / 语言",
    [
      { value: "zh", label: "中文" },
      { value: "en", label: "English" },
    ],
    fallback,
  );
}
