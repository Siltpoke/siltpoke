import { describe, expect, test } from "bun:test";
import { pngChunkTypes, pngSize } from "../../_util/png-chunks";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRCs are written as zeros: the parser only walks length/type framing and
// never checks them, so real CRCs would add nothing to what is under test.
function chunk(type: string, data: number[]): number[] {
  const n = data.length;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255,
    ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
const ihdr = (w: number, h: number) =>
  chunk("IHDR", [w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0]);
const png = (...parts: number[][]) => new Uint8Array([...SIG, ...parts.flat()]);

describe("png-chunks", () => {
  test("lists chunk types in order", () => {
    const b = png(ihdr(3, 2), chunk("IDAT", [1, 2, 3]), chunk("IEND", []));
    expect(pngChunkTypes(b)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  test("sees an inserted tEXt chunk", () => {
    const b = png(ihdr(3, 2), chunk("tEXt", [65, 0, 66]), chunk("IDAT", [1]), chunk("IEND", []));
    expect(pngChunkTypes(b)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
  });

  test("pngSize reads big-endian IHDR width and height", () => {
    const b = png(ihdr(1000, 258), chunk("IDAT", [1]), chunk("IEND", []));
    expect(pngSize(b)).toEqual({ w: 1000, h: 258 });
  });

  test("works on a subarray view with a nonzero byteOffset", () => {
    const inner = png(ihdr(7, 9), chunk("IEND", []));
    const padded = new Uint8Array([0, 0, 0, ...inner]).subarray(3);
    expect(pngSize(padded)).toEqual({ w: 7, h: 9 });
  });

  test("non-PNG input throws", () => {
    expect(() => pngChunkTypes(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
    expect(() => pngChunkTypes(new Uint8Array(0))).toThrow(/signature/);
  });

  test("truncated input throws, never loops or reads past the end", () => {
    const full = png(ihdr(3, 2), chunk("IDAT", [1, 2, 3]), chunk("IEND", []));
    for (let cut = 8; cut < full.length; cut++) {
      expect(() => pngChunkTypes(full.subarray(0, cut))).toThrow(/truncated/);
    }
  });

  test("a chunk claiming a huge length throws", () => {
    const bad = new Uint8Array([...SIG, 0xff, 0xff, 0xff, 0xff, 73, 68, 65, 84, 0, 0, 0, 0]);
    expect(() => pngChunkTypes(bad)).toThrow(/truncated/);
  });

  test("bytes after IEND throw instead of being silently ignored", () => {
    const ok = png(ihdr(2, 3), chunk("IDAT", [0]), chunk("IEND", []));
    expect(() => pngChunkTypes(ok)).not.toThrow();
    const trailing = new Uint8Array([...ok, 0x41, 0x42]);
    expect(() => pngChunkTypes(trailing)).toThrow("2 trailing byte(s) after IEND");
  });

  test("pngSize throws when IHDR is not first", () => {
    expect(() => pngSize(png(chunk("IDAT", [1]), chunk("IEND", [])))).toThrow(/IHDR/);
  });
});
