// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * dailyCaps island — the cap field in each row of the Settings table (spec
 * §12.1, §12.3): one daily cap per role — Chat, Critic (`review`), Summarizer
 * (`extract`) — whichever agent the role uses.
 *
 * A field saves when it is left or Enter is pressed (`saveOne(role)` from
 * x-on:blur / x-on:keydown.enter); there is no Save button. A field that was
 * not changed sends nothing. A save POSTs all three caps to
 * /api/brain/daily-caps — the route requires all three — with the other two at
 * their LAST SAVED value, so a half-typed number in another row is never sent.
 * `✓ saved` shows under the field for `flashMs`.
 *
 * The check here is a courtesy (it names the field); the guard is the route's
 * writer, which refuses the same values.
 *
 * The secret is read from the container's own `data-secret` (closest()
 * includes self).
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts. Never addEventListener
 * on island DOM (hx-boost morph drops direct listeners) — bind via x-on:* .
 */

export type CapRole = "chat" | "review" | "extract";
type PerRole<T> = Record<CapRole, T>;

export interface DailyCapsData {
  /** What is in each field (x-model hands over a string). */
  values: PerRole<string>;
  /** The value the server last accepted for each role. */
  saved: PerRole<string>;
  /** `✓ saved` is showing under the field. */
  flash: PerRole<boolean>;
  /** The error under the field; "" = none. */
  errors: PerRole<string>;
  flashMs: number;
  /** Today's calls per role, from the page and then from /api/brain. */
  used: PerRole<number>;
  /** How often a visible page re-reads today's counts. */
  pollMs: number;
  init(): void;
  /** "N used today", or "no cap · N used today" when the saved cap is 0. */
  usedText(role: CapRole): string;
  /** Re-read today's counts; a hidden tab asks nothing, a bad reply changes nothing. */
  refreshUsage(): Promise<void>;
  /** From x-init: re-read every `pollMs` until destroy(). */
  startPolling(): void;
  destroy(): void;
  /** Typing in a field: its own error no longer describes what is on screen. */
  touched(role: CapRole): void;
  saveOne(role: CapRole): Promise<void>;
  /** One save, after the ones before it (see `queue`). */
  _send(role: CapRole, mine: number): Promise<void>;
}

/** A whole number of 0 or more, or null. */
function parseCap(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

const BAD = "must be a whole number, 0 or more (0 = no cap)";
const ROLES: readonly CapRole[] = ["chat", "review", "extract"];

const perRole = <T>(f: (role: CapRole) => T): PerRole<T> =>
  ({ chat: f("chat"), review: f("review"), extract: f("extract") }) as PerRole<T>;

export function makeDailyCaps(): DailyCapsData {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Replies can come back out of order; only the newest request's reply counts.
  let asked = 0;
  // Saves go one at a time. Each sends all three caps with the other two at
  // their last SAVED value, so two saves in flight at once (leave Chat, then
  // Critic, quickly) sent Critic's request with Chat's OLD number; if it landed
  // second it put the old Chat cap back while the page said ✓ saved (small
  // item [10] of the chat mainline). Queued, the second reads the first's result.
  let queue: Promise<void> = Promise.resolve();
  return {
    values: perRole(() => ""),
    saved: perRole(() => ""),
    flash: perRole(() => false),
    errors: perRole(() => ""),
    flashMs: 1500,
    used: perRole(() => 0),
    pollMs: 30_000,

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      for (const role of ROLES) {
        const v = el?.dataset[role] ?? "";
        this.values[role] = v;
        this.saved[role] = v;
        this.used[role] = parseCap(el?.dataset[`${role}Used`]) ?? 0;
      }
    },

    usedText(role: CapRole): string {
      const n = `${this.used[role]} used today`;
      return this.saved[role] === "0" ? `no cap · ${n}` : n;
    },

    async refreshUsage(): Promise<void> {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const mine = ++asked;
      try {
        const res = await fetch("/api/brain");
        if (!res.ok) return;
        const usage = ((await res.json()) as { usage?: Record<string, unknown> }).usage ?? {};
        if (mine !== asked) return;
        for (const role of ROLES) {
          const n = parseCap(usage[role]);
          if (n !== null) this.used[role] = n;
        }
      } catch {
        // Keep the numbers on screen; the next tick tries again.
      }
    },

    startPolling(): void {
      if (timer !== null) clearInterval(timer);
      timer = setInterval(() => void this.refreshUsage(), this.pollMs);
    },

    destroy(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },

    touched(role: CapRole): void {
      this.errors[role] = "";
    },

    saveOne(role: CapRole): Promise<void> {
      // Read the field now (what the user left); send when the saves before it are done.
      const mine = parseCap(this.values[role]);
      if (mine === null) {
        this.errors[role] = `Daily cap ${BAD}`;
        this.flash[role] = false;
        return Promise.resolve();
      }
      const run = queue.then(() => this._send(role, mine));
      queue = run.catch(() => {});
      return run;
    },

    async _send(role: CapRole, mine: number): Promise<void> {
      if (String(mine) === this.saved[role]) return;
      this.errors[role] = "";
      // The route needs all three. A role whose number the page did not carry
      // is never filled in: any stand-in would be a cap the user did not set,
      // and 0 would remove it.
      const others = perRole((r) => (r === role ? mine : parseCap(this.saved[r])));
      if (ROLES.some((r) => others[r] === null)) {
        this.errors[role] = "could not read the other caps — reload the page";
        return;
      }
      const body = others as PerRole<number>;
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      const secret = el?.closest("[data-secret]")?.getAttribute("data-secret") ?? "";
      try {
        const res = await fetch("/api/brain/daily-caps", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify(body),
        });
        // A reply that is not JSON still means the daemon answered: say what it
        // said, not "is the daemon running?".
        const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !reply.ok) {
          this.errors[role] = reply.error ?? `save failed (HTTP ${res.status})`;
          return;
        }
        // Only tidy the field if it still shows what was sent: a number typed
        // while this save waited its turn is the user's, not ours to replace.
        if (parseCap(this.values[role]) === mine) this.values[role] = String(mine);
        this.saved[role] = String(mine);
        this.flash[role] = true;
        setTimeout(() => {
          this.flash[role] = false;
        }, this.flashMs);
      } catch {
        this.errors[role] = "network error — is the daemon running?";
      }
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "dailyCaps",
    () => makeDailyCaps(),
  );
});
