import { expect, test } from "bun:test";
import { renderMenubar, type MenubarInput } from "../../src/face/menubar";
import { visualWidth } from "../../src/face/width";

const EMOJI = "🐱";
const base: Omit<MenubarInput, "reviews"> = {
  name: "Bangbang",
  emoji: EMOJI,
  dashboardUrl: "http://127.0.0.1:9876",
  nowMs: Date.parse("2026-07-08T12:00:00Z"),
};
const titlePrefix = `${EMOJI} `;

test("empty: emoji title, no badge, dashboard link only", () => {
  const out = renderMenubar({ ...base, reviews: [] });
  const [title] = out.split("\n");
  expect(title).toBe("🐱 Bangbang");
  expect(out).toContain("Open dashboard");
  expect(out).not.toContain("⚠");
});

test("badge is a plain activity count (all sessions, incl. clean feedback); emoji stays stable", () => {
  const out = renderMenubar({ ...base, reviews: [
    { repo: "r1", branch: "main", session: "aaa", comment: "real critique", severity: "high", critiqueId: "x", timestamp: "t1" },
    { repo: "r2", branch: null, session: "bbb", comment: "all clean ✓", severity: "info", critiqueId: "y", timestamp: "t2" },
  ]});
  // 2 active sessions → plain "2", no ⚠ triangle; emoji does not change by mood.
  expect(out.split("\n")[0]).toBe("🐱 Bangbang · 2");
  expect(out).not.toContain("⚠");
});

test("empty → no count number at all", () => {
  const out = renderMenubar({ ...base, reviews: [] });
  expect(out.split("\n")[0]).toBe("🐱 Bangbang");
});

test("tag line carries the builder-family tag (Slice B T6): 🔧 <authorFamily>", () => {
  const out = renderMenubar({ ...base, reviews: [
    { repo: "r", branch: "feat/x", session: "a3f", comment: "hi", severity: "low", critiqueId: "z", timestamp: "2026-07-08T11:57:00Z", authorFamily: "codebuddy" },
  ]});
  expect(out).toContain("🔧 codebuddy");
});

test("tag line: repo · branch · relative-time; branch omitted when null; no opaque #session", () => {
  const out = renderMenubar({ ...base, reviews: [
    { repo: "repo-a", branch: "feat/x", session: "a3f", comment: "hi", severity: "low", critiqueId: "z", timestamp: "2026-07-08T11:57:00Z" },
    { repo: "repo-b", branch: null, session: "7c1", comment: "yo", severity: "low", critiqueId: "w", timestamp: "2026-07-08T11:57:00Z" },
  ]});
  // base.nowMs = 12:00:00Z, review at 11:57:00Z → "3m ago"
  expect(out).toContain("repo-a · feat/x · 3m ago");
  expect(out).toContain("repo-b · 3m ago");
  expect(out).not.toContain("repo-b · null");
  // the opaque 3-char session id must no longer appear in the tag
  expect(out).not.toContain("#a3f");
  expect(out).not.toContain("#7c1");
});

test("relative-time buckets: just now / m / h / d", () => {
  const mk = (timestamp: string) => renderMenubar({ ...base, reviews: [
    { repo: "r", branch: null, session: "s", comment: "c", severity: "low", critiqueId: "x", timestamp },
  ]}).split("\n").find((l) => l.includes("color=#888"))!;
  expect(mk("2026-07-08T11:59:40Z")).toContain("· just now"); // 20s
  expect(mk("2026-07-08T11:45:00Z")).toContain("· 15m ago");
  expect(mk("2026-07-08T09:00:00Z")).toContain("· 3h ago");
  expect(mk("2026-07-06T12:00:00Z")).toContain("· 2d ago");
});

test("escapes the | delimiter and newlines in comments", () => {
  const out = renderMenubar({ ...base, reviews: [
    { repo: "r", branch: "m", session: "s", comment: "bad | pipe\nand newline", severity: "low", critiqueId: "c", timestamp: "t" },
  ]});
  const commentLine = out.split("\n").find((l) => l.includes("pipe"))!;
  expect(commentLine.split("|").length).toBe(2); // exactly one | — the href param delimiter
  expect(commentLine).not.toContain("\nand");
});

// Supplementary: the design doc names comment, repo, AND branch as injection
// vectors. Guard the tag-line sanitize() call too.
test("escapes | and newlines in repo/branch/name, not just comment", () => {
  const out = renderMenubar({
    ...base,
    name: "Bad|Name\nX",
    reviews: [
      { repo: "r|1\n", branch: "b|2\n", session: "s", comment: "ok", severity: "low", critiqueId: "c", timestamp: "t" },
    ],
  });
  const title = out.split("\n")[0];
  expect(title).not.toContain("|");
  expect(title).not.toContain("\n");
  const tagLine = out.split("\n").find((l) => l.includes("color=#888"))!;
  expect(tagLine.split("|").length).toBe(2);
  expect(tagLine).not.toContain("\nb");
});

// D2: name/comment truncate by visual width (name 24, comment 60), append "…"
// only when clipped; truncation runs AFTER sanitize.
test("title name longer than 24 visual cols is truncated with …", () => {
  const longName = "A".repeat(40);
  const out = renderMenubar({ ...base, name: longName, reviews: [] });
  const title = out.split("\n")[0];
  expect(title).toContain("…");
  expect(title).not.toContain(longName);
  const namePortion = title.slice(titlePrefix.length);
  expect(visualWidth(namePortion)).toBeLessThanOrEqual(25); // 24 + "…"
});

test("card comment longer than 60 visual cols is truncated with …", () => {
  const longComment = "z".repeat(90);
  const out = renderMenubar({ ...base, reviews: [
    { repo: "r", branch: "m", session: "s", comment: longComment, severity: "low", critiqueId: "c", timestamp: "t" },
  ]});
  const commentLine = out.split("\n").find((l) => l.includes("href=") && l.includes("/timeline"))!;
  expect(commentLine).toContain("…");
  expect(commentLine).not.toContain(longComment);
  const commentText = commentLine.split(" | ")[0];
  expect(visualWidth(commentText)).toBeLessThanOrEqual(61); // 60 + "…"
});

test("short name and comment are left untouched (no stray …)", () => {
  const out = renderMenubar({ ...base, name: "Bangbang", reviews: [
    { repo: "r", branch: "m", session: "s", comment: "short one", severity: "low", critiqueId: "c", timestamp: "t" },
  ]});
  const title = out.split("\n")[0];
  expect(title).toBe("🐱 Bangbang · 1"); // 1 active session → plain count
  expect(title).not.toContain("…");
  const commentLine = out.split("\n").find((l) => l.includes("short one"))!;
  expect(commentLine).not.toContain("…");
});

test("restart field renders a non-terminal, self-refreshing Restart daemon row (AC23)", () => {
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/Users/x/.bun/bin/bun", script: "/abs/cli/daemon.ts" },
  });
  expect(out).toContain(
    "🔄 Restart daemon | bash=/Users/x/.bun/bin/bun param1=/abs/cli/daemon.ts param2=restart terminal=false refresh=true",
  );
});

test("no restart field → no Restart row, Refresh still last", () => {
  const out = renderMenubar({ ...base, reviews: [] });
  expect(out).not.toContain("Restart daemon");
  expect(out.trimEnd().endsWith("Refresh | refresh=true")).toBe(true);
});

test("dashboard field → Open dashboard runs the `dashboard` verb (starts daemon), not a bare href", () => {
  const out = renderMenubar({
    ...base,
    reviews: [],
    dashboard: { bun: "/Users/x/.bun/bin/bun", cli: "/abs/dist/siltpoke-cli.js" },
  });
  expect(out).toContain(
    "🖥 Open dashboard (see all) | bash=/Users/x/.bun/bin/bun param1=/abs/dist/siltpoke-cli.js param2=dashboard terminal=false refresh=false",
  );
  // must NOT still emit the bare-href form that hits a dead :9876 when the daemon is off
  expect(out).not.toContain("🖥 Open dashboard (see all) | href=");
});

test("no dashboard field → Open dashboard falls back to a plain href", () => {
  const out = renderMenubar({ ...base, reviews: [] });
  expect(out).toContain("🖥 Open dashboard (see all) | href=http://127.0.0.1:9876");
});

// --- restart outcome visibility ---
//
// The SwiftBar restart row runs with `terminal=false`, so SwiftBar discards
// stdout AND stderr. Making `siltpoked restart` honest therefore fixed nothing
// at the surface where the bug was actually reported: from the menu bar, a
// failed restart still looked like "I clicked and nothing happened". The
// outcome has to come back into the menu itself.

test("a recent FAILED restart renders a SHORT headline, with the detail in a submenu", () => {
  // Measured against a real menu bar: the full sentence on one row overflowed
  // the dropdown width and was clipped mid-word, so the part that actually said
  // what to do never reached the eye. The row has to be scannable; the detail
  // belongs one level down, where it has room to wrap.
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: {
      ok: false,
      at: new Date(base.nowMs - 30_000).toISOString(),
      summary: "didn't take effect",
      message:
        "the daemon serving :9876 did not change (still pid 23624) — another process is probably holding the port",
    },
  });
  const rows = out.split("\n");
  const head = rows.find((l) => l.startsWith("⚠"));
  expect(head).toBeDefined();
  // Short enough to survive the dropdown without clipping.
  expect(head!.split(" | ")[0].length).toBeLessThan(40);
  expect(head).toContain("didn't take effect");

  // The full reason is reachable, as submenu rows.
  const sub = rows.filter((l) => l.startsWith("--"));
  expect(sub.length).toBeGreaterThan(0);
  expect(sub.join(" ")).toContain("23624");
  // and each submenu line is itself short enough to read
  for (const l of sub) expect(l.length).toBeLessThan(70);
});

test("a successful restart renders no warning row", () => {
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: { ok: true, at: new Date(base.nowMs - 30_000).toISOString(), summary: "restarted", message: "restarted" },
  });
  expect(out).not.toContain("⚠ Restart");
});

// --- restart SUCCESS feedback (FIX B) ---
//
// A restart that silently worked looked identical, from the menu bar, to a
// click that did nothing — the failure row existed but success was mute.
// A short green confirmation row closes that gap without adding noise: it
// only appears while fresh, same TTL as the failure row.

test("a fresh successful restart renders a short green '✓ Restarted HH:MM' row", () => {
  // base.nowMs = 2026-07-08T12:00:00Z; put the outcome 30s earlier so it is
  // unambiguously fresh, and assert the exact local HH:MM it renders.
  const at = new Date(base.nowMs - 30_000);
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: { ok: true, at: at.toISOString(), summary: "restarted", message: "restarted" },
  });
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const rows = out.split("\n").filter((l) => l.startsWith("✓"));
  expect(rows.length).toBe(1);
  expect(rows[0]).toBe(`✓ Restarted ${hh}:${mm} | color=green`);
  // one line, and still no warning row alongside it
  expect(out).not.toContain("⚠ Restart");
});

test("a STALE successful restart stops rendering the success row too", () => {
  // Same TTL discipline as the failure row — this is "what just happened",
  // not a permanent banner.
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: {
      ok: true,
      at: new Date(base.nowMs - 60 * 60_000).toISOString(),
      summary: "restarted",
      message: "restarted",
    },
  });
  expect(out).not.toContain("✓ Restarted");
});

test("a fresh FAILED restart still renders the ⚠ row, not the ✓ row (branch selection)", () => {
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: {
      ok: false,
      at: new Date(base.nowMs - 30_000).toISOString(),
      summary: "didn't take effect",
      message: "did not change",
    },
  });
  expect(out).toContain("⚠ Restart");
  expect(out).not.toContain("✓ Restarted");
});

test("a stale failure stops nagging", () => {
  // The row exists to answer "what happened when I just clicked", not to be a
  // permanent banner. SwiftBar re-renders on a timer, so an old failure would
  // otherwise sit there forever.
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: {
      ok: false,
      at: new Date(base.nowMs - 60 * 60_000).toISOString(),
      summary: "didn't take effect",
      message: "did not change",
    },
  });
  expect(out).not.toContain("⚠ Restart");
});

test("a failure message containing SwiftBar delimiters cannot break the row", () => {
  const out = renderMenubar({
    ...base,
    reviews: [],
    restart: { bun: "/b", script: "/s" },
    restartOutcome: {
      ok: false,
      at: new Date(base.nowMs - 1_000).toISOString(),
      summary: "boom | href=http://evil",
      message: "boom | href=http://evil\nextra row",
    },
  });
  const warnRows = out.split("\n").filter((l) => l.includes("⚠ Restart"));
  // One row, not two: the embedded newline must not forge a second one.
  expect(warnRows.length).toBe(1);
  // The payload survives as inert TEXT — that is fine and is what sanitize()
  // does. What must not survive is its ability to be PARSED: SwiftBar splits a
  // row on " | ", so the row may carry exactly one such separator, the one this
  // renderer authors. Asserting the substring is absent would be asserting the
  // wrong thing (and would pass for the wrong reason if sanitize ever changed
  // to deletion instead of substitution).
  expect(warnRows[0].split(" | ").length).toBe(2);
  expect(warnRows[0]).toContain("¦"); // the pipe was neutralized, not dropped
  expect(warnRows[0].endsWith("color=orange")).toBe(true);
});
