// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * chatAgent island — the chip in the chat panel that says which coding agent
 * answers chat right now, and (in its tooltip) why.
 *
 * The panel named the agent only while another agent's whole reply was pending
 * and never for claude, so after changing agents nothing in the panel showed
 * that the change had taken. The chip reads GET /api/brain → `chat`, which is
 * `resolveChatProvider`'s own answer — the same call the chat route makes per
 * message — so it shows what the NEXT message will use. It does not label
 * replies already on screen.
 *
 * A separate island nested inside the floatingChat one: the panel's own island
 * is at its length pin. It is refreshed from the panel's markup (x-effect on
 * `open` / `streaming`), so it re-reads when the panel opens and when a reply
 * ends, and a change made on the Settings page shows without a reload.
 *
 * Registration: document.addEventListener("alpine:init", ...) before
 * Alpine.start(). Imported by src/web/client/index.ts.
 */
import { asAgent } from "../lib/chat-error-copy";

interface ChatAgentChip {
  /** "" = show no chip. */
  label: string;
  title: string;
}

const NO_CHIP: ChatAgentChip = { label: "", title: "" };

const WHY: Record<string, string> = {
  chosen: "you chose it on the Settings page",
  installed: "it is the only one found on this machine",
};

/** A model id as a CLI takes it (brackets included: `claude-opus-4-8[1m]`); anything else is not shown. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/;

/**
 * A model id cut down to what a person calls it: `claude-haiku-4-5-20251001` →
 * `haiku 4.5`. The family prefix and a trailing date are dropped and a
 * `name-4-5` version becomes `name 4.5`; anything else is left as it is. The
 * full id stays in the tooltip.
 */
function shortModel(family: string, model: string): string {
  const bare = (model.startsWith(`${family}-`) ? model.slice(family.length + 1) : model).replace(/-\d{8}$/, "");
  return bare.replace(/^([a-z]+)-(\d+)-(\d+)(?!\d)/, "$1 $2.$3");
}

/** What the chip says for one `chat` value of GET /api/brain. Unknown input → no chip. */
function chatAgentChip(chat: unknown): ChatAgentChip {
  if (chat === null || typeof chat !== "object") return NO_CHIP;
  const c = chat as { kind?: unknown; family?: unknown; model?: unknown; source?: unknown };
  if (c.kind === "choose") {
    return {
      label: "will ask which agent",
      title: "More than one coding agent is installed and none is chosen for chat — chat will ask you which to use. You can also set it on the Settings page.",
    };
  }
  if (c.kind === "none") {
    return { label: "no agent installed", title: "No coding-agent command line was found on this machine." };
  }
  if (c.kind !== "use") return NO_CHIP;
  const family = asAgent(c.family);
  if (!family) return NO_CHIP;
  const model = typeof c.model === "string" && MODEL.test(c.model) ? c.model : null;
  const why = WHY[String(c.source)] ?? "";
  // No model configured = the CLI's own default. A model that is set but not
  // shown must not be described as the default — it is still what gets passed.
  const modelNote = model ? "" : c.model === undefined ? ` The model is ${family}'s own default.` : " Its model is not shown here.";
  return {
    label: model ? `${family} · ${shortModel(family, model)}` : family,
    title: `Chat is answered by ${family}${model ? ` (${model})` : ""}${why ? ` — ${why}` : ""}.${modelNote} Change it on the Settings page.`,
  };
}

interface ChatAgentData extends ChatAgentChip {
  refresh(): Promise<void>;
}

function makeChatAgent(): ChatAgentData {
  // Not reactive state: an x-effect that calls refresh() must not depend on it.
  let latest = 0;
  return {
    label: "",
    title: "",

    async refresh(): Promise<void> {
      const mine = ++latest;
      let chip = NO_CHIP;
      try {
        const res = await fetch("/api/brain");
        if (res.ok) chip = chatAgentChip(((await res.json()) as { chat?: unknown } | null)?.chat);
      } catch {
        // No chip is better than an old name: the panel still works without it.
      }
      // A slower, older read must not replace a newer one.
      if (mine !== latest) return;
      this.label = chip.label;
      this.title = chip.title;
    },
  };
}

document.addEventListener("alpine:init", () => {
  (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
    "chatAgent",
    () => makeChatAgent(),
  );
});
