// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * build-stamp island — the sidebar footer's "which build is this daemon
 * serving" line. Fetches `GET /api/version` on init (read-only, no secret,
 * same as the other read GETs) and renders the already-derived line.
 *
 * Client-side rather than SSR on purpose: the line belongs in the shared
 * Dashboard shell, and threading it through as a prop would mean editing all
 * sixteen screens AND coupling every SSR test to the machine's git state.
 * The derivation itself stays on the server — this island renders a decision
 * it does not make, so there is exactly one place the wording can drift.
 *
 * A failed fetch renders NOTHING rather than a reassuring default. The whole
 * point of the line is that silence is what a stale daemon looked like before
 * it existed; a green-looking placeholder would rebuild that failure mode.
 *
 * Registration: `alpine:init` before Alpine.start() walks the DOM, imported
 * for side effects by src/web/client/index.ts. The URL comes from the
 * `data-build-url` attribute the shell sets, matching stalenessBadge's
 * "read a data-* attribute in init()" convention.
 */
import { tokens } from "../../tokens/tokens";

export type BuildLineState = "ok" | "warn" | "unknown";

export interface BuildLinePayload {
  show: boolean;
  state: BuildLineState;
  text: string;
  title: string;
}

export interface BuildStampData {
  ready: boolean;
  line: BuildLinePayload;
  url: string;
  init(): void;
  fetchBuild(): Promise<void>;
  tone(): string;
}

/**
 * warn → amber, matching stalenessBadge's "drifting" tier: a mismatch here is
 * something to act on, not a failure. `ok` and `unknown` both sit at ink3 —
 * the line is ambient, and colouring a healthy build green would make the
 * footer compete with the daemon dot beside it.
 */
const STATE_COLOR: Record<BuildLineState, string> = {
  ok: tokens.color.ink3,
  warn: tokens.color.amber,
  unknown: tokens.color.ink3,
};

const BLANK: BuildLinePayload = { show: false, state: "unknown", text: "", title: "" };

export function makeBuildStamp(fetchFn: typeof fetch = fetch): BuildStampData {
  return {
    ready: false,
    line: { ...BLANK },
    url: "",

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.url = el?.dataset.buildUrl ?? "";
      void this.fetchBuild();
    },

    /**
     * Named `tone`, not `color`: `color(...)` is a real CSS color function, so
     * an `x-bind:style="{ color: color() }"` binding reads as a baked color
     * literal to `tests/web/rendered-output-colors.test.ts` and fails eleven
     * routes at once. The guard is right and blunting it for one caller would
     * cost more than the rename.
     */
    tone(): string {
      return STATE_COLOR[this.line.state] ?? tokens.color.ink3;
    },

    async fetchBuild(): Promise<void> {
      if (!this.url) return;
      try {
        const res = await fetchFn(this.url);
        if (!res.ok) return;
        const body = (await res.json()) as { line?: BuildLinePayload };
        // A response without a usable line leaves the footer blank — never a
        // partially-populated row that reads as a measurement.
        if (!body.line || !body.line.show || !body.line.text) return;
        this.line = body.line;
        this.ready = true;
      } catch {
        // Blank, deliberately. See the file header.
      }
    },
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
      "buildStamp",
      () => makeBuildStamp(),
    );
  });
}
