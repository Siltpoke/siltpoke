// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { resolveAgentBinary } from "../installer/agent-bin";
import { detectAgents, reportAgents } from "../installer/agent-detect";
import { selectAndInstallAgents } from "../installer/agent-menu";
import { backupSettings, findLatestBackup, restoreFromBackup } from "../installer/backup";
import type { EditorPresence } from "../installer/editor-detect";
import { detectEditors, editorOpener, extensionScheme, resolveEditorBranch } from "../installer/editor-detect";
import { t } from "../installer/i18n";
import { askLocale } from "../installer/locale-prompt";
import { describePlatform } from "../installer/os-arch";
import { resolveClaudeHome } from "../installer/paths";
import { buildInstallPlan } from "../installer/platform-plan";
import { installPlc, type PlcExec } from "../installer/plc-install";
import { preflight } from "../installer/preflight";
import { type Exec, ensureBun, ensureGit } from "../installer/prereq";
import { RollbackStack } from "../installer/rollback";
import { askChoice, askYesNo, realWizardIO, type WizardIO } from "../installer/wizard";
import { type AgentTarget, runInstall } from "./install";

export interface BootstrapOpts {
  exec: Exec;
  io: WizardIO;
  claudeHome: string;
  check?: boolean;
  yes?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  // runInstallFn now receives the detected/offered agent preset.
  runInstallFn?: (io: WizardIO, presetAgents: AgentTarget[]) => Promise<unknown>;
  detectEditorsFn?: () => EditorPresence;
  /** Exec seam for the optional project-lifecycle plugin install step,
   *  injectable for tests (see plcExec below for why it must never throw). */
  plcExecFn?: PlcExec;
}

export interface BootstrapResult {
  status: "planned" | "installed" | "refused" | "rolled-back" | "no-host";
  plan: string[];
  rolledBack?: string[];
  error?: string;
}

function defaultRunInstallFn(claudeHome: string): (io: WizardIO, presetAgents: AgentTarget[]) => Promise<unknown> {
  return (wio, presetAgents) =>
    runInstall({ io: wio, env: { ...process.env, CLAUDE_HOME: claudeHome }, presetAgents });
}

/** Wraps a WizardIO so any askYesNo prompt auto-answers "y" instead of reading real input. */
function autoYesIo(io: WizardIO): WizardIO {
  return { write: io.write, readLine: async () => "y" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Real (non-test) plcExec default: shells out via Bun.spawnSync. Pulled out
// to module scope (rather than an inline closure inside runBootstrap) so a
// test can call it directly with a binary guaranteed not to resolve and
// exercise the inner try/catch for real — every test in bootstrap.test.ts
// injects `plcExecFn`, so this exact inner catch (the actual Linux code
// path: Bun.spawnSync THROWS synchronously, not a non-zero exit, when the
// binary can't be resolved at all) was previously only exercised by the
// OUTER safety net in runBootstrap (see the try/catch around installPlc
// below), never directly. See tests/cli/bootstrap.test.ts.
export const defaultPlcExec: PlcExec = (cmd, args, env) => {
  try {
    const r = Bun.spawnSync([cmd, ...args], { env: env ?? process.env });
    return { status: r.exitCode ?? 1, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
  } catch (err: unknown) {
    return { status: 1, stdout: "", stderr: errorMessage(err) };
  }
};

export async function runBootstrap(opts: BootstrapOpts): Promise<BootstrapResult> {
  const { exec, io, claudeHome, check, yes, runInstallFn: injectedRunInstall } = opts;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const pf = preflight(exec, claudeHome, platform);
  const plan = buildInstallPlan(pf.prereqs, platform);
  if (pf.refuse) return { status: "refused", plan };

  // AC9: detect + report CLI agents (report on --check too).
  const presence = detectAgents({ exec, platform });
  io.write(`${reportAgents(presence)}\n`);
  if (check) return { status: "planned", plan };

  const rollback = new RollbackStack();
  try {
    const promptIo = yes ? autoYesIo(io) : io;

    // P4: localized wizard surface — language prompt, OS/arch line, editor question.
    const locale = await askLocale(io, { yes });
    io.write(`${t("wizard.title", locale)}\n`);
    io.write(`✓ ${describePlatform(platform, arch)}\n`);
    const editors = (opts.detectEditorsFn ?? (() => detectEditors()))();
    const detected = editors.vscode || editors.cursor;
    const usesEditor = await askYesNo(promptIo, t("editor.useEditor", locale), { default: detected ? "yes" : "no" });

    // AC14 Claude gate + AC10/AC11/AC13 multi-agent picker.
    const selection = await selectAndInstallAgents({ presence, io: promptIo, exec, platform, locale });
    if (selection.exit) return { status: "no-host", plan };
    const presetAgents = selection.presetAgents;

    await ensureBun(exec, promptIo, platform);
    await ensureGit(exec, promptIo, platform);
    if (pf.settingsExisted) {
      await backupSettings(claudeHome, undefined, platform);
      rollback.push({
        label: "restore settings.json",
        undo: async () => {
          const b = await findLatestBackup(claudeHome);
          if (b) await restoreFromBackup(claudeHome, b);
        },
      });
    }

    await (injectedRunInstall ?? defaultRunInstallFn(claudeHome))(io, presetAgents);

    // AC15-17: install project-lifecycle (suppression-guarded, non-fatal).
    // Bun.spawnSync THROWS synchronously (not a non-zero exit) when the
    // binary can't be resolved at all (e.g. `claude` genuinely absent on
    // PATH and every resolveAgentBinary fallback path) — confirmed via
    // `Bun.spawnSync(["missing-bin"])` -> "Executable not found in $PATH".
    // installPlc's own contract says this step is non-fatal ("a real
    // failure warns rather than throws"), but an uncaught throw here used
    // to escape into the outer catch below and roll back the ENTIRE
    // install — undoing a successful core install just because the
    // optional PLC plugin step couldn't shell out. This is exactly what
    // happened on Linux CI (no `claude` binary present at all): every
    // bootstrap run that reached this line came back "rolled-back" instead
    // of "installed". The default exec catches its own spawn failures; the
    // try/catch below is a second, exec-source-agnostic safety net so an
    // injected plcExecFn (tests, or a future caller) can't defeat the
    // documented "warn, don't throw" contract either.
    const plcExec: PlcExec = opts.plcExecFn ?? defaultPlcExec;
    // claudePresent: true — reachable only past the no-host gate, so Claude is expected
    // present (or was just installed); using presence.claude here would wrongly skip PLC
    // right after a successful install.
    try {
      const claudeBin = resolveAgentBinary("claude");
      installPlc({ exec: plcExec, io, claudePresent: true, claudeBin });
    } catch (err: unknown) {
      io.write(
        `! project-lifecycle install step failed unexpectedly (${errorMessage(err)}) — siltpoke core is fine.\n`,
      );
    }

    const branch = resolveEditorBranch(usesEditor, editors);
    if (branch === "C") {
      io.write(`✓ ${t("done.terminalC", locale)}\n`);
    } else {
      if (branch === "B") {
        const wantsOpen = await askYesNo(promptIo, t("editor.pluginOffer", locale), { default: "yes" });
        const editor: "vscode" | "cursor" =
          editors.cursor && !editors.vscode
            ? "cursor"
            : editors.vscode && !editors.cursor
              ? "vscode"
              : editors.vscode && editors.cursor
                ? ((await askChoice(promptIo, t("editor.pickWhich", locale), ["vscode", "cursor"] as const, "vscode")))
                : "vscode";
        const scheme = extensionScheme(editor);
        if (wantsOpen) {
          const opener = editorOpener(platform);
          exec(opener[0], [...opener.slice(1), scheme]);
        } else {
          io.write(`${scheme}\n`);
        }
      }
      io.write(`✓ ${t("done.editor", locale)}\n`);
    }

    return { status: "installed", plan };
  } catch (err: unknown) {
    const rolledBack = await rollback.unwind();
    return { status: "rolled-back", plan, rolledBack, error: errorMessage(err) };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const exec: Exec = (cmd, a) => {
    // `command -v` is a POSIX shell builtin (no `command` binary); `where` is a
    // real Windows executable. Route the builtin through a shell; spawn the rest directly.
    // Same fix mirrored in ./install.ts's `defaultExec` — see that comment for
    // why (macOS/BSD ship a /usr/bin/command shim, Debian/Ubuntu do not) and
    // why args are passed as positional shell parameters ($1, $2, ...) rather
    // than interpolated into the `-c` script text.
    const spawnArgs =
      cmd === "command"
        ? ["sh", "-c", `command ${a.map((_, i) => `"$${i + 1}"`).join(" ")}`, "_", ...a]
        : [cmd, ...a];
    const r = Bun.spawnSync(spawnArgs);
    return { status: r.exitCode ?? 1, stdout: r.stdout?.toString() ?? "" };
  };
  const res = await runBootstrap({
    exec,
    io: realWizardIO(),
    claudeHome: resolveClaudeHome(),
    check: args.includes("--check"),
    yes: args.includes("--yes"),
  });
  console.log(`siltpoke bootstrap plan:\n- ${res.plan.join("\n- ")}\n→ ${res.status}`);
  process.exit(res.status === "refused" || res.status === "rolled-back" ? 1 : 0);
}
