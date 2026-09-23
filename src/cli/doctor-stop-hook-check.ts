// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The Stop-hook doctor row, split out of src/cli/doctor.ts verbatim.
//
// Why it moved: doctor.ts sits at the ratchet's 800-line hard cap
// (scripts/lint-file-length.ts), and by that script's own rule a pin may only
// move DOWN — so the defect [20]-[24] round had to make room rather than grow
// the file. This row and its two shape types are self-contained.

import { join } from "node:path";
import { resolveClaudeHome } from "../installer/paths";
import { type CheckResult, type DoctorOptions, detectDoctorHost, hostWiringPath, readJson, setupAdviceFor } from "./doctor";
import { pluginOwnsStopHook } from "./doctor-plugin-hook-check";
import { isPluginInstall } from "./doctor-plugin-install";

interface HookEntryShape {
  type?: unknown;
  url?: unknown;
  command?: unknown;
}
interface HookMatcherShape {
  hooks?: HookEntryShape[];
}

export function checkStopHook(opts: DoctorOptions): CheckResult {
  const name = "Stop hook registered (curl fast path + command pair)";

  // Defect [16]: everything below reads Claude Code's settings.json. Under a
  // positively-detected other host that is a question about the wrong machine
  // — and that host has its own row (checkAgyHooksJson for agy).
  const host = detectDoctorHost(opts);
  if (host !== "claude-code") {
    return {
      name,
      pass: true,
      status: "info",
      detail: `skipped — this is a ${host} install; its Stop hook lives in ${hostWiringPath(host, opts)}`,
    };
  }

  // Plugin era: hooks/hooks.json (shipped with the plugin, copied to
  // ${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json on install) owns the Stop hook,
  // not settings.json — same "plugin owns this, not settings.json" pattern
  // as checkSlashSymlinks below. A healthy plugin install has an EMPTY
  // settings.json hooks.Stop[]; asserting on it here would fail every
  // correct plugin install. Only fall through to the legacy settings.json
  // check when the plugin manifest itself doesn't declare a Stop hook.
  if (isPluginInstall(opts) && pluginOwnsStopHook(opts)) {
    return {
      name,
      pass: true,
      status: "info",
      detail: "plugin-owned — hooks/hooks.json declares the Stop hook (settings.json hooks.Stop[] is expected empty)",
    };
  }

  const path = join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  const r = readJson(path);
  if (!r.ok) {
    return { name, pass: false, detail: `${path} not readable — settings.json must exist first` };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object — cannot read hooks.Stop` };
  }
  const settings = r.value as { hooks?: { Stop?: unknown } };
  const stopArr = settings.hooks?.Stop;
  if (!Array.isArray(stopArr) || stopArr.length === 0) {
    return { name, pass: false, detail: "hooks.Stop[] is missing or empty in settings.json" };
  }
  const shape = scanStopMatchers(stopArr as HookMatcherShape[]);
  if (shape === "curl") return { name, pass: true, detail: null };
  if (shape === "legacy") {
    // Pre-track-#6 http fast path still works but prints Claude Code's red
    // ECONNREFUSED when the daemon is down — healthy, migration recommended.
    return {
      name,
      pass: true,
      status: "info",
      detail: `legacy http Stop hook shape detected. ${setupAdviceFor(host)} to migrate to the silent curl fast path.`,
    };
  }
  return {
    name,
    pass: false,
    detail: `no Stop hook matcher contains both the curl fast path (command ~ curl … /hooks/stop) and a command fallback (~ on-stop.ts). ${setupAdviceFor(host)} to re-register.`,
  };
}

/**
 * Scan Stop matchers for the canonical curl+on-stop pair (track #6; written by
 * settings-mutator.ts buildStopCurlCommand) or the legacy http+on-stop pair.
 * Shape check, not content check — doctor doesn't know the secret.
 */
function scanStopMatchers(matchers: HookMatcherShape[]): "curl" | "legacy" | "none" {
  let sawLegacyPair = false;
  for (const m of matchers) {
    const hooks = Array.isArray(m?.hooks) ? m.hooks : [];
    const cmds = hooks
      .filter((h) => h.type === "command" && typeof h.command === "string")
      .map((h) => h.command as string);
    const hasCurl = cmds.some((c) => c.includes("curl") && c.includes("/hooks/stop"));
    const hasCmd = cmds.some((c) => c.includes("on-stop.ts"));
    const hasHttp = hooks.some(
      (h) => h.type === "http" && typeof h.url === "string" && h.url.includes("/hooks/stop"),
    );
    if (hasCurl && hasCmd) return "curl";
    if (hasHttp && hasCmd) sawLegacyPair = true;
  }
  return sawLegacyPair ? "legacy" : "none";
}
