// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What dashboard chat is told when the user chats from Home (/): the page as
 * plain text — the pet, its stats and XP, and today's budget — read through
 * the same `getHomeData` the Home route renders from.
 *
 * Chat does not get the page's `?repo=` project, so memory is read globally;
 * nothing written here depends on the project.
 */
import { GLOBAL_ONLY } from "../memory/memory";
import { getHomeData, type HomeData } from "../web/screens/Home.data";

const n = (v: number): string => Math.round(v).toLocaleString("en-US");
/** As StatsPanel shows a stat: clamped to 0–10, rounded. The stored values are decaying floats. */
const stat = (v: number): number => Math.round(Math.max(0, Math.min(10, v)));

/** The page as text. Pure: the caller reads the data. */
export function homePageText(d: HomeData): string {
  const s = d.stats;
  const today = d.xp.xpToday ?? 0;
  const lines = [
    `Pet: ${d.pet.name}, ${d.petTitle || d.pet.species}, level ${d.pet.level}, mood ${d.pet.mood}. Together ${d.together}, since ${d.startDate ?? "today"}. Last poke: ${d.meta.lastPokeAt}.${d.topbarBadges.wellFed ? " Well-fed." : ""}`,
    `Stats (out of 10): hp ${stat(s.hp)}, hunger ${stat(s.hunger)}, energy ${stat(s.energy)}, mood ${stat(s.mood)}, bond ${stat(s.bond)}.`,
    // As StatsPanel shows it: `xpToNext` is the level's total, not what is left.
    `XP: level ${d.xp.level} → ${d.xp.nextLevel}, ${n(d.xp.xp)} / ${n(d.xp.xpToNext)}, ${n(d.xp.xpToNext - d.xp.xp)} to go${today > 0 ? `; ${n(today)} today${d.xp.xpTodayCapped ? " (today's cap reached)" : ""}` : ""}.`,
  ];
  const b = d.telemetry.budget;
  const budget = [`Budget today: ${b.stage}, ${b.used_pct.toFixed(1)}% used, ${n(b.remaining_tokens)} tokens remaining`];
  const r = b.rollup;
  if (r) {
    budget.push(
      `input ${n(r.total_input_tokens)}, output ${n(r.total_output_tokens)}, cache (raw) ${n(r.total_cache_tokens)}, ${n(r.brain_calls)} brain calls, $${r.total_cost_usd.toFixed(4)} today`,
    );
  }
  lines.push(`${budget.join("; ")}.`);
  if (d.telemetry.gateState.checks.some((c) => c.name === "quiet hours" && !c.pass)) lines.push("Quiet hours are on.");
  if (d.brainHealth.show && d.brainHealth.line) lines.push(`Warning shown: ${d.brainHealth.line}`);
  return lines.join("\n");
}

export async function readHomePageText(homeBase: string, now: Date = new Date()): Promise<string> {
  return homePageText(await getHomeData({ basePath: homeBase, now, memoryScope: GLOBAL_ONLY }));
}
