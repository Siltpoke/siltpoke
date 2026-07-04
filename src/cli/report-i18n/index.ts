// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { I18nDict } from "./types";
import { EN } from "./en";
import { ZH_CN } from "./zh-cn";
import { JA } from "./ja";
import { KO } from "./ko";

export type { I18nKey, I18nDict } from "./types";
export { EN, ZH_CN, JA, KO };

export const I18N: Record<string, I18nDict> = {
  en: EN,
  "zh-CN": ZH_CN,
  "zh-TW": ZH_CN, // close enough for chrome strings
  ja: JA,
  ko: KO,
};

export function pickDict(language: string): I18nDict {
  if (I18N[language]) return I18N[language]!;
  // Tolerate variants like "zh", "en-US", etc.
  const head = language.split("-")[0] ?? "";
  if (head && I18N[head]) return I18N[head]!;
  if (head === "zh") return ZH_CN;
  return EN;
}

export function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}
