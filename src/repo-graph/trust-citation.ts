import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function citationExists(root: string, file: string, line: number): boolean {
  if (!Number.isInteger(line) || line < 1 || isAbsolute(file)) return false;
  const abs = resolve(root, file);
  try {
    const realRoot = realpathSync(root);
    const realAbs = realpathSync(abs);
    const rel = relative(realRoot, realAbs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const text = readFileSync(abs, "utf8");
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    return lines >= line;
  } catch {
    return false;
  }
}
