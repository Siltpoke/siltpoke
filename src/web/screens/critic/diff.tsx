// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critic diff module barrel — preserves the historical
 * "./critic/diff" import path. Implementation moved to ./diff/{parse,render}
 * to address god-function findings on the
 * legacy parse/align functions.
 */
export { DiffSummaryView, DiffView } from "./diff/render";
