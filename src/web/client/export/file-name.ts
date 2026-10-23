// Export file names (AC31): `code-map-<source>-<YYYY-MM-DD>.<ext>`. Never the
// repo name — a file name travels further than the image's contents do.
import type { TrustSource } from "../../../repo-graph/trust-map";

const pad = (n: number): string => String(n).padStart(2, "0");

export function exportFileName(source: TrustSource, date: Date, ext: "png" | "md" | "html"): string {
  // Local calendar day: what the person exporting would call "today".
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `code-map-${source}-${day}.${ext}`;
}
