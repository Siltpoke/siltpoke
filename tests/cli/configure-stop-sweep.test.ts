// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The legacy Stop-hook sweep, in isolation: a PURE function over a settings
// object, no fs, no home dir. Its whole job is deciding which Stop entries are
// OURS — and, just as importantly, which merely mention the word "siltpoke" and
// must be left alone. That distinction is what makes it worth its own file.
import { describe, expect, test } from "bun:test";
import { removeLegacyStopHook } from "../../src/cli/configure";

describe("removeLegacyStopHook", () => {
  test("strips a settings.json Stop hook that runs siltpoke, keeps everyone else's", () => {
    const before = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "bun /Users/x/siltpoke/src/hooks/on-stop.ts" }] },
          { hooks: [{ type: "command", command: "notify-send done" }] },
        ],
      },
    };
    const after = removeLegacyStopHook(before) as typeof before;
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]?.hooks[0]?.command).toBe("notify-send done");
  });

  test("leaves settings with no Stop hooks untouched", () => {
    const before = { statusLine: { type: "command", command: "x" } };
    expect(removeLegacyStopHook(before)).toEqual(before);
  });

  test("strips the daemon curl fast-path and the stale type:http entry too", () => {
    // Both shapes were written by pre-plugin installs (settings-mutator's
    // registerStopHookPair). Neither carries the literal lowercase "siltpoke"
    // in a `command` string — the curl one hides it in a header name, the http
    // one has no `command` at all.
    const before = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "http", url: "http://127.0.0.1:9876/hooks/stop" },
              {
                type: "command",
                command:
                  'curl --silent --max-time 5 -X POST -H "X-Siltpoke-Secret: abc" --data-binary @- http://127.0.0.1:9876/hooks/stop >/dev/null 2>&1 || true',
              },
            ],
          },
        ],
      },
    };
    const after = removeLegacyStopHook(before) as { hooks?: { Stop?: unknown[] } };
    expect(after.hooks?.Stop ?? []).toHaveLength(0);
  });

  test("keeps a foreign hook that shares a matcher with ours", () => {
    const before = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "bun ~/siltpoke/src/hooks/on-stop.ts" },
              { type: "command", command: "say done" },
            ],
          },
        ],
        PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }],
      },
    };
    const after = removeLegacyStopHook(before) as typeof before;
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]?.hooks).toEqual([{ type: "command", command: "say done" }]);
    // Other hook events are none of our business.
    expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
  });

  test("does not mutate the input object", () => {
    const before = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun x/hooks/on-stop.ts" }] }] },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    removeLegacyStopHook(before);
    expect(before).toEqual(snapshot);
  });

  // The word "siltpoke" is a COINCIDENCE, not an anchor. It appears in any path
  // under a siltpoke checkout or a siltpoke-named notes dir, so matching on the
  // bare substring silently deleted hooks that were never ours.
  test("keeps a FOREIGN hook whose command merely contains the word siltpoke", () => {
    const foreign = [
      // The user's own hook — it just happens to run from the siltpoke repo dir.
      "cd /Users/x/dev/siltpoke && make lint-notify",
      // A different tool entirely; "siltpoke" appears only inside a path.
      "otherpet --log /Users/x/siltpoke-notes/x.log",
      // A hook that talks ABOUT siltpoke without being siltpoke.
      "echo 'siltpoke is sleeping' >> ~/hooks.log",
    ];
    const before = {
      hooks: {
        Stop: [{ hooks: foreign.map((command) => ({ type: "command", command })) }],
      },
    };
    const after = removeLegacyStopHook(before) as typeof before;
    // Every last one survives — untouched, in order.
    expect(after.hooks.Stop[0]?.hooks.map((h) => h.command)).toEqual(foreign);
  });

  test("still strips all three real shapes our own installer wrote", () => {
    const before = {
      hooks: {
        Stop: [
          {
            hooks: [
              // 1. the Brain-call entry (any clone dir — the anchor is the file name)
              { type: "command", command: "bun /opt/tools/pet-reviewer/src/hooks/on-stop.ts" },
              // 2. the curl fast-path (tell: our auth header)
              {
                type: "command",
                command:
                  'curl --silent --max-time 5 -X POST -H "X-Siltpoke-Secret: abc" --data-binary @- http://127.0.0.1:9876/hooks/stop >/dev/null 2>&1 || true',
              },
              // 3. the stale type:"http" entry (no `command` at all)
              { type: "http", url: "http://127.0.0.1:9876/hooks/stop" },
              // … next to a foreign hook sharing the matcher, which must survive.
              { type: "command", command: "say done" },
            ],
          },
        ],
      },
    };
    const after = removeLegacyStopHook(before) as typeof before;
    expect(after.hooks.Stop[0]?.hooks).toEqual([{ type: "command", command: "say done" }]);
  });

  test("reports every entry it removes (deleting user config must be visible)", () => {
    const removed: string[] = [];
    removeLegacyStopHook(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "bun ~/siltpoke/src/hooks/on-stop.ts" },
                { type: "http", url: "http://127.0.0.1:9876/hooks/stop" },
                { type: "command", command: "notify-send done" },
              ],
            },
          ],
        },
      },
      (d) => removed.push(d),
    );
    expect(removed).toEqual([
      "bun ~/siltpoke/src/hooks/on-stop.ts",
      "http://127.0.0.1:9876/hooks/stop",
    ]);
  });
});
