// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Install audit §110 W6: on Claude Code (2.1.300 on Windows, and 2.1.301 on
// macOS) a bare `/siltpoke-brain show` answers "Unknown
// command"; a plugin install's commands exist only as `/siltpoke:siltpoke-x`.
// Every place that tells the user to type one of ours must use that form.
// One form everywhere was chosen over a per-install-type name.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const COMMANDS = readdirSync(".claude-plugin/commands")
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/^siltpoke-/, "").replace(/\.md$/, ""));

/** A bare `/siltpoke-<command>` that is not a path segment (`dir/siltpoke-x.md`) or already namespaced. */
function bareMentions(text: string): string[] {
  const names = [...COMMANDS].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9:~./_}\\-])/siltpoke-(${names})(?![A-Za-z0-9-]|\\.(md|ts|js|sh)\\b)`, "g");
  return [...text.matchAll(re)].map((m) => m[0]);
}

const SURFACES = ["src", "hooks", "skills", ".claude-plugin/commands", "docs/MANUAL.md", "docs/install-prompts", "README.md"];
const files = execFileSync("git", ["ls-files", "--", ...SURFACES], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|md|sh|ps1|yaml|json|html)$/.test(f));

describe("user-facing command names carry the plugin namespace", () => {
  test("the scan sees the surfaces and the commands (device check)", () => {
    expect(COMMANDS).toContain("brain");
    expect(COMMANDS.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeGreaterThan(100);
  });

  test("the matcher finds a bare name and spares paths and namespaced names", () => {
    expect(bareMentions("run /siltpoke-wake now")).toEqual(["/siltpoke-wake"]);
    expect(bareMentions("run /siltpoke:siltpoke-wake now")).toEqual([]);
    expect(bareMentions("commands/siltpoke-doctor.md and ${dir}/siltpoke-doctor.md")).toEqual([]);
  });

  test("no shipped surface tells the user to type a bare /siltpoke-<command>", () => {
    const hits = files.flatMap((f) => bareMentions(readFileSync(f, "utf8")).map((m) => `${f}: ${m}`));
    expect(hits).toEqual([]);
  });
});
