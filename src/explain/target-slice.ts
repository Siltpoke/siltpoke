/**
 * Line-sliced, line-numbered target source for the pinned chat (defects [40] / [77]).
 * Split out of prompt-assembly.ts to keep that file under the length cap.
 */

/**
 * The target node's own lines, cut on a line boundary once `maxBytes` is
 * reached. Line numbers are 1-based and inclusive, like `lineRange`.
 *
 * Every line is sent with its real FILE line number as a `N| ` gutter (defect
 * [77]: unnumbered, the model counted from the header's start line and was
 * off by 2-6 on a pinned function). The cap is applied to the NUMBERED text,
 * so the gutter's bytes are paid for inside `maxBytes`. `raw` is the same kept
 * lines without the gutter, for the "Calls" identifier scan.
 */
export function sliceTargetLines(
  content: string,
  lineRange: [number, number],
  maxBytes: number,
): { body: string; raw: string; firstLine: number; lastLine: number; truncated: boolean } {
  const lines = content.split("\n");
  // A trailing newline yields one empty last element that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  // A range that starts past the end of the file names lines that are not
  // there (the file shrank after indexing): show the file from the top rather
  // than its last line. A range that only runs long is clamped.
  const startsInFile = lineRange[0] >= 1 && lineRange[0] <= lines.length;
  const firstLine = startsInFile ? lineRange[0] : 1;
  const wantedLast = startsInFile
    ? Math.min(Math.max(firstLine, lineRange[1]), lines.length)
    : lines.length;
  const kept: string[] = [];
  let bytes = 0;
  for (let n = firstLine; n <= wantedLast; n++) {
    const line = lines[n - 1] ?? "";
    const cost = Buffer.byteLength(`${n}| ${line}`, "utf8") + 1;
    if (kept.length > 0 && bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  const lastLine = firstLine + kept.length - 1;
  // The first line is kept whatever its size, so a line longer than the cap
  // (a minified file is one line) has to be cut inside the line. Left whole it
  // would pass the cap here and then be dropped as a block by the bundle
  // budget — the model would get no source at all, with nothing saying so.
  const first = kept[0] ?? "";
  const gutter = `${firstLine}| `;
  if (kept.length === 1 && Buffer.byteLength(gutter + first, "utf8") > maxBytes) {
    const room = Math.max(0, maxBytes - Buffer.byteLength(gutter, "utf8"));
    const head = Buffer.from(first, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "");
    return {
      raw: head,
      body: `${gutter}${head}\n// … (truncated: line ${firstLine} is longer than ${maxBytes} bytes; showing its start, of lines ${firstLine}-${wantedLast})\n`,
      firstLine,
      lastLine,
      truncated: true,
    };
  }
  const truncated = lastLine < wantedLast;
  const marker = truncated
    ? `\n// … (truncated: showing lines ${firstLine}-${lastLine} of ${firstLine}-${wantedLast})\n`
    : "";
  const numbered = kept.map((l, i) => `${firstLine + i}| ${l}`).join("\n");
  return { body: numbered + marker, raw: kept.join("\n"), firstLine, lastLine, truncated };
}
