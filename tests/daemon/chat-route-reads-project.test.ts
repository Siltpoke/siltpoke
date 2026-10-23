// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The send side of "which agents read the project" (src/chat/repo-access.ts),
// through POST /api/chat with a REAL child: a fake agent CLI on disk records
// its argv, folder and stdin. The unit tests pin `readsProject` and the block
// wording; these pin that the route hands each agent the block meant for it
// and the folder meant for it — and nothing to an agent that does not read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";
import type { ChatProviderResolution } from "../../src/brain/chat-provider";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openChatTurn } from "../../src/daemon/routes/chat-turn-source";

const SECRET = "test-secret";

interface Launch {
  bin: string;
  argv: string[];
  cwd: string;
  stdin: string;
}

let home = "";
let bin = "";
let proj = "";
let log = "";
let idx: ChatIndex;
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.SILTPOKE_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "chat-reads-home-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "chat-reads-bin-")));
  proj = realpathSync(mkdtempSync(join(tmpdir(), "chat-reads-proj-")));
  log = join(bin, "launches.jsonl");
  savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  process.env.SILTPOKE_HOME = home;
  resetQuotaWarnStateForTests();
  idx = openIndex(home);
});

afterEach(() => {
  idx.close();
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = savedHome;
  for (const d of [home, bin, proj]) rmSync(d, { recursive: true, force: true });
});

/** A fake agent CLI answering in its family's own reply format. */
function fakeCli(name: string): void {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "const stdin = await Bun.stdin.text();",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), stdin }) + "\\n");`,
      `const bin = ${JSON.stringify(name)};`,
      'if (bin === "codex") {',
      '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }) + "\\n");',
      '} else if (bin === "agy") {',
      '  process.stdout.write("ok");',
      "} else {",
      '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 7, output_tokens: 3 } }));',
      "}",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

/** Sends one Code Map message with the project open; returns what the agent was started with. */
async function send(family: "codex" | "agy" | "qoder", binName: string): Promise<Launch> {
  fakeCli(binName);
  const resolution = { kind: "use", family, source: "settings", commandDir: bin } as unknown as ChatProviderResolution;
  const app = new Hono();
  mountChatRoutes(app, {
    homeBase: home,
    index: idx,
    secret: SECRET,
    resolveChatProvider: () => resolution,
    resolveProjectRootByHash: async (h: string) => (h === "abc123" ? proj : null),
  } as never);
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
    body: JSON.stringify({ message: "what is in utils?", page: "/repo-graph", view: { repo: "proj", selection: null, proj_hash: "abc123" } }),
  });
  await res.text();
  const rows = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0) : [];
  expect(rows.length).toBe(1);
  return JSON.parse(rows[0] as string) as Launch;
}

/** Everything the agent was told: the prompt may travel in argv or on stdin. */
const told = (l: Launch): string => [...l.argv, l.stdin].join("\n");

describe("POST /api/chat with the project open: each agent gets its own folder and block", () => {
  test("agy: told the project's path and the outside limit; still runs in its own empty folder", async () => {
    const l = await send("agy", "agy");
    expect(told(l)).toContain(`The project is at ${proj}.`);
    expect(told(l)).toContain(`Do not read anything outside ${proj}.`);
    expect(told(l)).not.toContain("Your working directory is its root");
    expect(told(l)).not.toContain("You cannot open the user's files");
    expect(l.cwd).not.toBe(proj);
    expect(l.cwd).not.toBe(join(home, "chat-cwd"));
  });

  // codex reads only where its sandbox limits reads (macOS); this runs on whichever this machine is.
  test("codex: on macOS runs in the project with its block; elsewhere the empty chat folder and the no-access block", async () => {
    const l = await send("codex", "codex");
    const folder = l.argv[l.argv.indexOf("-C") + 1];
    if (process.platform === "darwin") {
      expect(folder).toBe(proj);
      expect(told(l)).toContain(`Your working directory is its root (${proj}); your read-only tools work there.`);
      expect(told(l)).not.toContain("The project is at");
      expect(told(l)).not.toContain("Read, Grep and Glob");
    } else {
      expect(folder).toBe(join(home, "chat-cwd"));
      expect(told(l)).not.toContain("You can read the user's project");
      expect(told(l)).toContain("You cannot open the user's files");
    }
  });

  // The route already withholds the folder from qoder; this pins the second
  // gate, in openChatTurn, for a caller that hands it a folder anyway.
  test("openChatTurn: a folder handed in for qoder is not passed on", async () => {
    fakeCli("qodercli");
    const resolution = { kind: "use", family: "qoder", source: "settings", commandDir: bin } as unknown as ChatProviderResolution;
    const turn = openChatTurn({
      homeBase: home,
      resolution,
      transcript: "[user] hi",
      systemPrompt: "be brief",
      signal: new AbortController().signal,
      cwd: proj,
    });
    for await (const _ of turn.stream) {
      // drain: the launch record is what is checked
    }
    const l = JSON.parse(readFileSync(log, "utf8").trim()) as Launch;
    expect(l.cwd).toBe(join(home, "chat-cwd"));
    expect(l.cwd).not.toBe(proj);
  });

  test("qoder: no project folder, no reading block, the no-access block", async () => {
    const l = await send("qoder", "qodercli");
    expect(l.cwd).toBe(join(home, "chat-cwd"));
    expect(told(l)).not.toContain(proj);
    expect(told(l)).not.toContain("You can read the user's project");
    expect(told(l)).toContain("You cannot open the user's files");
  });
});
