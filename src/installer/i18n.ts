// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

export type Locale = "zh" | "en";
export const LOCALES: readonly Locale[] = ["zh", "en"];

type Dict = Record<string, string>;

const EN: Dict = {
  "wizard.title": "siltpoke setup wizard",
  "wizard.lang": "Language / 语言",
  "editor.useEditor": "Do you use VS Code / Cursor?",
  "agent.installCli": "Also install a command-line (CLI) agent? (optional — your editor / Desktop app already attaches)",
  "agent.docsHint": "CLI vs IDE editor vs Desktop? → see docs",
  "done.editor": "Done — siltpoke is wired into your Claude. Keep coding where you already do; it reviews your work.",
  "agents.pick": "Which coding agents should siltpoke set up? (siltpoke supported ones install; 🔜 ones are coming soon)",
  "editor.pluginOffer": "Open your editor to install the Claude Code extension now?",
  "editor.pickWhich": "Which editor — VS Code or Cursor?",
  "done.terminalC": "Done — siltpoke is wired into Claude Code. Run `claude` and keep coding; it reviews as you go.",
};

const ZH: Dict = {
  "wizard.title": "siltpoke 安装向导",
  "wizard.lang": "语言 / Language",
  "editor.useEditor": "你平时用 VS Code / Cursor 吗？",
  "agent.installCli": "想顺便装个命令行 (CLI) agent 吗？（可选 —— 你的编辑器 / 桌面 App 已经能接 siltpoke）",
  "agent.docsHint": "命令行 (CLI) / IDE 编辑器 / 桌面 App 有什么区别？→ 看文档",
  "done.editor": "装好了 —— siltpoke 已接到你的 Claude。照常在你习惯的地方写代码，它会帮你审查。",
  "agents.pick": "让 siltpoke 给哪些编程助手接上？（siltpoke 支持的会真安装；🔜 的还在路上）",
  "editor.pluginOffer": "现在打开你的编辑器去装 Claude Code 扩展吗？",
  "editor.pickWhich": "哪个编辑器 —— VS Code 还是 Cursor？",
  "done.terminalC": "装好了 —— siltpoke 已接到 Claude Code。运行 `claude` 照常写代码，它会边写边帮你审查。",
};

const STRINGS: Record<Locale, Dict> = { en: EN, zh: ZH };

export function t(key: string, locale: Locale): string {
  return STRINGS[locale]?.[key] ?? EN[key] ?? key;
}
