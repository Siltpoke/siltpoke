// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { godFileRule } from "./tier1/god-file";
import { testGapRule } from "./tier1/test-gap";
import { godFunctionRule } from "./tier2/god-function";
import { deepNestingRule } from "./tier2/deep-nesting";
import { longParamListRule } from "./tier2/long-param-list";
import { defensiveOverreachRule } from "./tier2/defensive-overreach";
import { sprawlingAbstractionRule } from "./tier2/sprawling-abstraction";
import { narratingCommentRule } from "./tier2/narrating-comment";
import { magicNumberRule } from "./tier2/magic-number";
import { booleanParamRule } from "./tier2/boolean-param";
import { commentedOutCodeRule } from "./tier2/commented-out-code";
import { repoMemoryInconsistencyRule, repoMemoryConventionRule } from "../../repo-memory/rules";
import type { RubricRule } from "./types";

export const ALL_RUBRIC_RULES: ReadonlyArray<RubricRule> = [
  godFileRule, testGapRule,
  godFunctionRule, deepNestingRule, longParamListRule,
  defensiveOverreachRule, sprawlingAbstractionRule,
  narratingCommentRule, magicNumberRule, booleanParamRule, commentedOutCodeRule,
  repoMemoryInconsistencyRule, repoMemoryConventionRule,
];
