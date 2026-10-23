// Markdown appendix (spec §7.7, AC17): the stamp, per-container folders with
// coverage and the exact listed files, then the edge evidence table. Written
// for a human or an agent to read next to the image; every path is already
// repo-relative (daemon guard) and is re-checked by assertNoAbsolutePaths
// before download. The on-screen "Key pieces" (`comp`) are not exported.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "../islands/repo-graph-c4-model";
import { type ListedEdge, listedEdges } from "./edge-list";

type Evidence = ListedEdge["evidence"];
type Folder = TrustMap["containers"][number]["folders"][number];

/** One line of markdown-safe prose: newlines collapsed, pipes escaped. */
const cell = (s: string): string => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

function evidenceText(e: Evidence): string {
  if (e.kind === "import") return `import ×${e.count}`;
  if (e.kind === "cited") return `cited ${e.file}:${e.line}`;
  return `none (${e.reason})`;
}

function folderLine(f: Folder): string {
  return f.listed === null
    ? `- \`${f.folder}\``
    : `- \`${f.folder}\` — AI listed ${f.listed} of ${f.total} files`;
}

function containerSection(c: TrustMap["containers"][number]): string[] {
  const out = [`## ${cell(c.title)}`, "", `id: \`${c.id}\``, ""];
  out.push(...c.folders.map(folderLine));
  if (c.listedFiles.length) out.push("", "Listed files:", ...c.listedFiles.map((f) => `- \`${f}\``));
  out.push("");
  return out;
}

export function buildAppendixMd(model: C4Model, trust: TrustMap, stampLine: string): string {
  const out = [`# Code Map appendix — ${trust.source} view`, "", stampLine, ""];
  if (trust.totals) out.push(`AI listed ${trust.totals.listed} of ${trust.totals.total} files.`, "");
  for (const c of trust.containers) out.push(...containerSection(c));
  // Edge endpoints that are not containers (people, external systems) — named here so the table below reads.
  const others = Object.entries(model.N).filter(([, n]) => n.kind !== "cont");
  if (others.length) out.push("## Other nodes", "", ...others.map(([id, n]) => `- \`${id}\` — ${cell(n.title)}`), "");
  if (trust.notShown.length) out.push(`Not shown: ${trust.notShown.join(", ")}`, "");
  // `#` is the number drawn on the edge and in the image's key; a trust edge the image does not draw has none.
  out.push("## Edges", "", "| # | source → target | verb | evidence |", "|---|---|---|---|");
  // Every edge the image draws, plus any trust edge it does not (edge-list.ts) — the legend's "listed in the appendix" is this table.
  for (const e of listedEdges(model, trust)) {
    // Ids, not titles: titles are AI prose and can repeat; ids are unique and
    // match the `id:` line of each section above. Ids are still cell()-escaped
    // (a `|` in one would add a column). Two edges with the same source>target
    // are one trust entry upstream, consistent with the page's edgeTierKey.
    out.push(`| ${e.n ?? ""} | ${cell(e.source)} → ${cell(e.target)} | ${cell(e.verb)} | ${evidenceText(e.evidence)} |`);
  }
  return `${out.join("\n")}\n`;
}
