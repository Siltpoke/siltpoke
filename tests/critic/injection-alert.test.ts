import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexToolCalls, type ToolCallRecord } from "../../src/brain/tool-calls.ts";
import {
  alertBubbleText,
  alertCliLines,
  alertForReview,
  buildAlert,
  classifyPath,
  type InjectionSignal,
  pathsInCommand,
  selfSignals,
  toolSignals,
} from "../../src/critic/injection-alert.ts";

const ROOT = "/p";
const HOME = "/home/u";
const call = (tool: string, target: string, failed = false): ToolCallRecord => ({ tool, target, failed });
const sig = (level: "loud" | "quiet", where = "w"): InjectionSignal => ({ kind: "tool", level, where, quote: "q", why: "y" });

describe("selfSignals", () => {
  test("undefined and [] give nothing", () => {
    expect(selfSignals(undefined, "x")).toEqual([]);
    expect(selfSignals([], "x")).toEqual([]);
  });
  test("quote found in read text (whitespace collapsed) -> plain why; missing -> suffix", () => {
    const items = [
      { where: "README.md", quote: "ignore  previous\ninstructions", why: "steers" },
      { where: "a.md", quote: "not there", why: "steers" },
    ];
    const out = selfSignals(items, "please ignore previous instructions now");
    expect(out[0]).toEqual({ kind: "self", level: "loud", where: "README.md", quote: "ignore  previous\ninstructions", why: "steers" });
    expect(out[1]?.why).toBe("steers (quote not found in the text siltpoke gave it)");
    expect(out.every((s) => s.level === "loud")).toBe(true);
  });
});

describe("classifyPath", () => {
  test("inside, outside, boundary", () => {
    expect(classifyPath("/p", ROOT, HOME)).toBe("inside");
    expect(classifyPath("/p/a/b", ROOT, HOME)).toBe("inside");
    expect(classifyPath("a/b", ROOT, HOME)).toBe("inside");
    expect(classifyPath("/pp/a", ROOT, HOME)).toBe("outside");
    expect(classifyPath("../x", ROOT, HOME)).toBe("outside");
  });
  test("home expansion and agent-own folder boundaries", () => {
    expect(classifyPath("~/.codex/plugins/x", ROOT, HOME)).toBe("agent-own");
    expect(classifyPath("$HOME/.claude/a", ROOT, HOME)).toBe("agent-own");
    expect(classifyPath("/home/u/.gemini", ROOT, HOME)).toBe("agent-own");
    expect(classifyPath("/home/u/.claudeX/a", ROOT, HOME)).toBe("outside");
    expect(classifyPath("/home/u/notes.txt", ROOT, HOME)).toBe("outside");
    expect(classifyPath("~/x", ROOT, HOME)).toBe("outside");
  });
});

describe("classifyPath compares real paths (F3)", () => {
  const made: string[] = [];
  const tmp = (base = tmpdir()): string => {
    const d = mkdtempSync(join(base, "ia-real-"));
    made.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  test.if(process.platform === "darwin")("root given as /tmp/x while the tool reports /private/tmp/x/a.ts -> inside", () => {
    const root = tmp("/tmp");
    writeFileSync(join(root, "a.ts"), "");
    expect(classifyPath(`/private${root}/a.ts`, root, HOME)).toBe("inside");
    expect(classifyPath(`/private${root}/missing/b.ts`, root, HOME)).toBe("inside");
  });
  test("root given through a symlinked alias -> the real path is inside", () => {
    const real = tmp();
    writeFileSync(join(real, "a.ts"), "");
    const alias = join(tmp(), "alias");
    symlinkSync(real, alias);
    expect(classifyPath(join(real, "a.ts"), alias, HOME)).toBe("inside");
  });
  test("a symlink inside the root pointing outside, read through it -> outside", () => {
    const root = tmp();
    const out = tmp();
    writeFileSync(join(out, "secret.txt"), "s");
    symlinkSync(out, join(root, "link"));
    expect(classifyPath(join(root, "link", "secret.txt"), root, HOME)).toBe("outside");
    expect(classifyPath("link/secret.txt", root, HOME)).toBe("outside");
    expect(classifyPath(join(root, "link", "not-there", "x.txt"), root, HOME)).toBe("outside");
    mkdirSync(join(root, "src"));
    expect(classifyPath(join(root, "src", "a.ts"), root, HOME)).toBe("inside");
  });
});

describe("pathsInCommand", () => {
  test("$HOME/x and quoted path with space", () => {
    expect(pathsInCommand('cat $HOME/x "/abs path/with space" ls')).toEqual(["$HOME/x", "/abs path/with space"]);
  });
  test("relative-up, tilde, ignores plain words", () => {
    expect(pathsInCommand("cat ../outside.txt ~/a src/b.ts a/../b")).toEqual(["../outside.txt", "~/a", "a/../b"]);
  });
});

describe("wrapped and odd shapes", () => {
  test("real codex fixture: /bin/zsh -lc \"sed ... ../outside.txt\" -> one loud for ../outside.txt", () => {
    const out = toolSignals([call("shell", "/bin/zsh -lc \"sed -n '1,200p' ../outside.txt\"")], ROOT, HOME);
    expect(out).toHaveLength(1);
    expect(out[0]?.level).toBe("loud");
    expect(out[0]?.where).toBe("../outside.txt");
  });
  test("program word is never a target", () => {
    expect(toolSignals([call("shell", "/usr/bin/cat src/a.ts")], ROOT, HOME)).toEqual([]);
    expect(pathsInCommand("ls /x/a && /usr/bin/cat /y/b | /bin/grep z")).toEqual(["/x/a", "/y/b"]);
  });
  test("file_change joined targets are split", () => {
    const out = toolSignals([call("file_change", "a.ts, /x/out/b.txt")], ROOT, HOME);
    expect(out.map((s) => [s.level, s.where])).toEqual([["loud", "/x/out/b.txt"]]);
  });
  test("Grep path containing ' in ' is still found", () => {
    expect(toolSignals([call("Grep", "foo in /x/stuff in here/f")], ROOT, HOME)[0]?.where).toBe("/x/stuff in here/f");
  });
  test("--flag=path, redirects and $(...)", () => {
    expect(pathsInCommand("rg foo --file=/x/o")).toEqual(["/x/o"]);
    expect(pathsInCommand("cat</x/o")).toEqual(["/x/o"]);
    expect(pathsInCommand("cat <../x")).toEqual(["../x"]);
    expect(pathsInCommand("echo $(cat /x/o)")).toEqual(["/x/o"]);
  });
  test("claude JSON-fallback target with an outside path", () => {
    const out = toolSignals([call("WebSearch", JSON.stringify({ query: "hi", opts: { file: "/x/out/c.txt" } }))], ROOT, HOME);
    expect(out.map((s) => [s.level, s.where])).toEqual([["loud", "/x/out/c.txt"]]);
    expect(toolSignals([call("X", '{"broken')], ROOT, HOME)).toEqual([]);
  });
});

describe("redirects, devices and pure-output commands (F1)", () => {
  const shell = (cmd: string) => toolSignals([call("shell", cmd)], ROOT, HOME).map((s) => [s.level, s.where]);
  test("2>/dev/null inside a wrapped command is not a read", () => {
    expect(shell('/bin/zsh -lc "rg -n foo src 2>/dev/null | head -20"')).toEqual([]);
  });
  test("a write target after > is skipped; the read before it stays", () => {
    expect(shell("cat /x/a > /tmp/x")).toEqual([["loud", "/x/a"]]);
    expect(shell("cat /x/a >> /tmp/x; cat /x/b >| /tmp/y; cat /x/c &> /tmp/z; cat /x/d 2>> /tmp/w")).toEqual([
      ["loud", "/x/a"],
      ["loud", "/x/b"],
      ["loud", "/x/c"],
      ["loud", "/x/d"],
    ]);
  });
  test("echo and printf arguments are not reads", () => {
    expect(shell("echo /outside/file")).toEqual([]);
    expect(shell("printf '%s\\n' /tmp/example")).toEqual([]);
    expect(shell("echo /a/b && cat /x/e")).toEqual([["loud", "/x/e"]]);
  });
  test("a read inside an echo/printf substitution is still a read (R17)", () => {
    expect(shell("echo `cat /etc/passwd`")).toEqual([["loud", "/etc/passwd"]]);
    expect(shell("echo $(cat ~/secret.txt)")).toEqual([["loud", "~/secret.txt"]]);
    expect(shell('echo "x $(cat /etc/hosts) y"')).toEqual([["loud", "/etc/hosts"]]);
    expect(shell("printf '%s' `cat /etc/passwd`")).toEqual([["loud", "/etc/passwd"]]);
    expect(shell("echo /etc/passwd")).toEqual([]);
    expect(shell("echo '$(cat /etc/passwd)'")).toEqual([]);
  });
  test("repeated substitution bodies give each path once", () => {
    expect(pathsInCommand("echo `cat /a/b` `cat /a/b` $(cat /a/b)")).toEqual(["/a/b"]);
  });
  test("odd substitutions never throw (R17)", () => {
    expect(() => pathsInCommand("echo `cat /a/b")).not.toThrow();
    expect(pathsInCommand("echo `cat /a/b")).toEqual(["/a/b"]);
    expect(pathsInCommand("echo $(cat /a/b")).toEqual(["/a/b"]);
    expect(() => pathsInCommand("echo $(echo $(echo $(echo $(echo $(cat /a/b)))))")).not.toThrow();
    expect(() => pathsInCommand("echo ``` $( `")).not.toThrow();
  });
  test("the word after < is still a read", () => {
    expect(shell("cat < ../x")).toEqual([["loud", "../x"]]);
  });
  test("devices never signal", () => {
    expect(shell("cat /dev/null /dev/stdin /dev/stdout /dev/stderr /dev/fd/3 /dev/tty")).toEqual([]);
  });
  test("a listing outside the project is still an outside read", () => {
    expect(shell("ls /tmp")).toEqual([["loud", "/tmp"]]);
  });
});

describe("toolSignals", () => {
  test("claude Read of an absolute path outside the root is loud", () => {
    const out = toolSignals([call("Read", "/x/outside/canary.txt")], ROOT, HOME);
    expect(out).toEqual([
      { kind: "tool", level: "loud", where: "/x/outside/canary.txt", quote: "/x/outside/canary.txt", why: "read outside the project" },
    ]);
  });
  test("claude Grep 'pattern in path' uses the path; bare pattern/URL ignored", () => {
    expect(toolSignals([call("Grep", "foo in /x/out")], ROOT, HOME)[0]?.where).toBe("/x/out");
    expect(toolSignals([call("Grep", "foo.*bar")], ROOT, HOME)).toEqual([]);
    expect(toolSignals([call("WebFetch", "https://example.com/a")], ROOT, HOME)).toEqual([]);
  });
  test("classification of a long command (does not exercise the recording cap)", () => {
    const out = toolSignals([call("shell", `echo ${"a".repeat(1480)} && cat /etc/passwd`)], ROOT, HOME);
    expect(out.map((o) => [o.level, o.where])).toEqual([["loud", "/etc/passwd"]]);
  });
  test("record -> classify: a ~1500-char codex command ending in cat /etc/passwd is one loud signal (R11)", () => {
    const command = `echo ${"a".repeat(1480)} && cat /etc/passwd`;
    const events = [{ type: "item.completed", item: { id: "i", type: "command_execution", command, exit_code: 0, status: "completed" } }];
    const out = toolSignals(codexToolCalls(events), ROOT, HOME);
    expect(out.map((o) => [o.level, o.where])).toEqual([["loud", "/etc/passwd"]]);
  });
  test("codex `cat ../outside.txt` run from the root is outside", () => {
    const out = toolSignals([call("shell", "cat ../outside.txt")], ROOT, HOME);
    expect(out).toHaveLength(1);
    expect(out[0]?.level).toBe("loud");
    expect(out[0]?.where).toBe("../outside.txt");
    expect(out[0]?.quote).toBe("cat ../outside.txt");
  });
  test("~/.codex/plugins/cache/siltpoke/SKILL.md is agent-own -> quiet", () => {
    const out = toolSignals([call("shell", "cat ~/.codex/plugins/cache/siltpoke/SKILL.md")], ROOT, HOME);
    expect(out).toHaveLength(1);
    expect(out[0]?.level).toBe("quiet");
    expect(out[0]?.why).toBe("read the agent's own folder");
  });
  test("a blocked (failed) outside read still counts and says blocked", () => {
    const out = toolSignals([call("Read", "/x/o.txt", true), call("Read", "/home/u/.claude/a", true)], ROOT, HOME);
    expect(out.map((s) => s.why)).toEqual(["read outside the project (blocked)", "read the agent's own folder (blocked)"]);
  });
  test("reads inside the root give no signal", () => {
    expect(toolSignals([call("Read", "/p/a.ts"), call("shell", "cat src/a.ts /p/b")], ROOT, HOME)).toEqual([]);
  });
  test("not_recorded and undefined give no tool signal", () => {
    expect(toolSignals("not_recorded", ROOT, HOME)).toEqual([]);
    expect(toolSignals(undefined, ROOT, HOME)).toEqual([]);
  });
});

describe("buildAlert", () => {
  test("none -> null; quiet only -> quiet; any loud -> loud", () => {
    expect(buildAlert([], "recorded")).toBeNull();
    expect(buildAlert([sig("quiet")], "recorded")?.level).toBe("quiet");
    const a = buildAlert([sig("quiet"), sig("loud")], "not_recorded");
    expect(a?.level).toBe("loud");
    expect(a?.toolRecord).toBe("not_recorded");
    expect(a?.signals).toHaveLength(2);
  });
});

describe("alertBubbleText", () => {
  test("uses first loud where, falling back to first signal", () => {
    const loud = buildAlert([sig("quiet", "q1"), sig("loud", "l1")], "recorded");
    if (!loud) throw new Error("alert");
    expect(alertBubbleText(loud, "proj")).toBe("⚠ Reviewer read outside the project: l1 (proj)");
    const quiet = buildAlert([sig("quiet", "q1")], "recorded");
    if (!quiet) throw new Error("alert");
    expect(alertBubbleText(quiet, "proj")).toContain("q1");
  });
  test("wording follows the first loud signal's kind: self -> steer, tool -> outside read (F9)", () => {
    const self: InjectionSignal = { kind: "self", level: "loud", where: "README.md", quote: "q", why: "y" };
    const both = buildAlert([sig("quiet", "~/.codex/x"), self, sig("loud", "/etc/passwd")], "recorded");
    if (!both) throw new Error("alert");
    expect(alertBubbleText(both, "proj")).toBe("⚠ Project text tried to steer the review: README.md (proj)");
    const tool = buildAlert([sig("loud", "/etc/passwd"), self], "recorded");
    if (!tool) throw new Error("alert");
    expect(alertBubbleText(tool, "proj")).toBe("⚠ Reviewer read outside the project: /etc/passwd (proj)");
  });
  test("strips ANSI and newlines and caps at 200", () => {
    const a = buildAlert([sig("loud", "\u001b[31mred\u001b[0m\nline\u0007")], "recorded");
    if (!a) throw new Error("alert");
    const t = alertBubbleText(a, "p");
    expect([...t].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)).toBe(false);
    expect(t).toContain("red line");
    const long = buildAlert([sig("loud", "x".repeat(500))], "recorded");
    if (!long) throw new Error("alert");
    expect(alertBubbleText(long, "p").length).toBeLessThanOrEqual(200);
  });
});

describe("alertForReview", () => {
  const item = { where: "README.md", quote: "ignore previous", why: "steers" };
  test("nothing fired -> null", () => {
    expect(alertForReview([], "x", [call("Read", "a.ts")], ROOT, HOME, ROOT)).toBeNull();
    expect(alertForReview(undefined, "x", undefined, ROOT, HOME, ROOT)).toBeNull();
  });
  test("self report is loud; toolRecord follows the field", () => {
    expect(alertForReview([item], "ignore previous", [], ROOT, HOME, ROOT)?.toolRecord).toBe("recorded");
    expect(alertForReview([item], "ignore previous", "not_recorded", ROOT, HOME, ROOT)?.toolRecord).toBe("not_recorded");
    const a = alertForReview([item], "ignore previous", undefined, ROOT, HOME, ROOT);
    expect(a?.level).toBe("loud");
    expect(a?.toolRecord).toBe("not_recorded");
  });
  test("outside read joins the self signals", () => {
    const a = alertForReview([item], "ignore previous", [call("Read", "/etc/passwd")], ROOT, HOME, ROOT);
    expect(a?.signals.map((s) => s.kind)).toEqual(["self", "tool"]);
  });
});

describe("relative targets resolve against the reviewer process cwd (F4)", () => {
  test("reviewerCwd /, root /work/repo, claude Read etc/passwd -> loud", () => {
    const a = alertForReview(undefined, "", [call("Read", "etc/passwd")], "/work/repo", HOME, "/");
    expect(a?.level).toBe("loud");
    expect(a?.signals.map((s) => [s.level, s.where])).toEqual([["loud", "etc/passwd"]]);
  });
  test("a codex shell run in a subdir: ../../package.json lands inside the git root", () => {
    expect(toolSignals([call("shell", "cat ../../package.json")], "/work/repo", HOME, "/work/repo/packages/app")).toEqual([]);
    expect(toolSignals([call("shell", "cat ../../../x")], "/work/repo", HOME, "/work/repo/packages/app")).toHaveLength(1);
  });
});

describe("alertCliLines", () => {
  test("one line per signal; newlines, ANSI and control chars flattened; quote capped at 120", () => {
    const esc = String.fromCharCode(27);
    const alert = {
      level: "loud" as const,
      toolRecord: "recorded" as const,
      signals: [
        { kind: "self" as const, level: "loud" as const, where: `a${esc}[31m.md`, quote: `line1\nline2\u0007${"x".repeat(300)}`, why: "steers" },
        { kind: "tool" as const, level: "quiet" as const, where: "~/.codex/x", quote: "cat ~/.codex/x", why: "own folder" },
      ],
    };
    const lines = alertCliLines(alert);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect([...l].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
    expect(lines[0]).toStartWith('⚠ injection attempt — a.md: "line1 line2 ');
    expect(lines[0]).toEndWith('…" (steers)');
    expect(lines[1]).toBe('· outside read (agent\'s own folder) — ~/.codex/x: "cat ~/.codex/x"');
  });

  test("any other quiet kind is worded as worth a look, capped and flattened", () => {
    const alert = {
      level: "quiet" as const,
      toolRecord: "recorded" as const,
      signals: [{ kind: "echo" as const, level: "quiet" as const, where: "a\nb", quote: `q${"z".repeat(300)}`, why: "w" }],
    };
    const [line] = alertCliLines(alert);
    expect(line).toStartWith('· worth a look — a b: "qz');
    expect(line).toEndWith('…"');
    expect(line).not.toContain("injection attempt");
  });

  test("a quiet scan signal is worded as possible instruction in project text; flattened and capped", () => {
    const alert = {
      level: "quiet" as const,
      toolRecord: "recorded" as const,
      signals: [{ kind: "scan" as const, level: "quiet" as const, where: "AGENTS.md\nline", quote: `a\nb${"y".repeat(300)}`, why: "w" }],
    };
    const [line] = alertCliLines(alert);
    expect(line).toStartWith('· possible instruction in project text — AGENTS.md line: "a by');
    expect(line).toEndWith('…"');
    expect([...(line ?? "")].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
    expect(line).not.toContain("injection attempt");
  });

  test("a loud signal stays byte-identical next to a scan line", () => {
    const alert = {
      level: "loud" as const,
      toolRecord: "recorded" as const,
      signals: [
        { kind: "self" as const, level: "loud" as const, where: "a.md", quote: "q", why: "steers" },
        { kind: "scan" as const, level: "quiet" as const, where: "b.md", quote: "z", why: "w" },
      ],
    };
    expect(alertCliLines(alert)).toEqual(['⚠ injection attempt — a.md: "q" (steers)', '· possible instruction in project text — b.md: "z"']);
  });
});
