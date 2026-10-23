// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What dashboard chat is told when the user chats from /settings: the page as
 * plain text, read the way the /settings route reads it (src/web/routes/
 * settings.tsx) and worded by the same helpers the page renders with.
 */
import { dailyCapsView } from "../brain/daily-caps-view";
import { readCodexConfigModel } from "../brain/providers/codex";
import { brainView } from "../cli/brain-cli";
import { lastCalls } from "../web/screens/settings-last-calls";
import { settingsPageText } from "../web/screens/settings-text";
import { localRunStore } from "./run-store";

/** `codexHome`: test seam — the home whose ~/.codex/config.toml is read. Default: the user's home. */
export async function readSettingsPageText(
  homeBase: string,
  now: Date = new Date(),
  codexHome?: string,
): Promise<string> {
  const view = brainView(homeBase);
  const caps = dailyCapsView(homeBase, now);
  const last = await lastCalls(homeBase, localRunStore(homeBase));
  return settingsPageText({ view, caps, last, now, codexModel: readCodexConfigModel(codexHome) });
}
