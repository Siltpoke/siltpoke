// Run with TZ set (see model-window-tz.test.ts): prints what the window says
// about lists saved late at night and just after midnight, local time.
import { modelWindowView } from "../../../src/brain/model-window";

const evening = new Date(2026, 9, 15, 23, 30); // local Oct 15, 11:30 pm
const morning = new Date(2026, 9, 15, 0, 30); // local Oct 15, 0:30 am
const empty = { entries: [], error: null, fetchedAt: null };
const lists = (at: string) => ({
  fetchedAt: at,
  families: {
    claude: empty,
    codex: empty,
    agy: empty,
    qoder: { entries: [{ id: "Q", family: "qoder", description: null, tier: false }], error: "timed out", fetchedAt: at },
    codebuddy: empty,
  },
});
const facts = { index: {}, claudeModels: [], fetchedAt: null, offline: false, checked: false };
const out = [evening, morning].map((d) => {
  const v = modelWindowView(lists(d.toISOString()) as never, facts as never, { now: d });
  return { savedOn: v.savedOn, qoder: v.sources.find((s) => s.name === "qoder")?.text };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
