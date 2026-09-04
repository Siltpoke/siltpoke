// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A minimal 8-bit RGBA PNG reader for asset assertions.
 *
 * Exists so a test can assert what a shipped icon actually PAINTS rather than
 * how many bytes it is. The two tab-icon variants are the same glyph in
 * opposite ink; emitting one of them twice, or swapping which is which,
 * produces two valid PNGs of plausible size that both serve 200, and no
 * assertion about length or dimensions can tell the difference.
 *
 * Only the shapes this repo generates are handled — anything else throws
 * rather than returning plausible garbage.
 */

/** Width and height as declared in the PNG's own IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 8-byte signature + 4-byte chunk length + 4-byte "IHDR" type puts width at
  // offset 16 and height at 20, both big-endian.
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The per-byte addend each PNG filter type contributes. */
function unfilter(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function concatIdat(png: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let at = 8;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") {
      chunks.push(png.subarray(at + 8, at + 8 + len));
    }
    at += 12 + len;
  }
  return Buffer.concat(chunks);
}

/** Decoded pixels as RGBA quadruplets, row-major. */
export function decodePngRgba(input: Uint8Array, inflate: (b: Buffer) => Buffer): Buffer {
  const png = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const { width, height } = pngSize(input);
  const bitDepth = png.readUInt8(24);
  const colorType = png.readUInt8(25);
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA, got depth=${bitDepth} colorType=${colorType}`);
  }

  const raw = inflate(concatIdat(png));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(pos++);
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out.readUInt8(row + x - bpp) : 0;
      const up = y > 0 ? out.readUInt8(row - stride + x) : 0;
      const upLeft = x >= bpp && y > 0 ? out.readUInt8(row - stride + x - bpp) : 0;
      const add = unfilter(filter, left, up, upLeft);
      out.writeUInt8((raw.readUInt8(pos + x) + add) & 0xff, row + x);
    }
    pos += stride;
  }
  return out;
}

/**
 * Mean brightness of the OPAQUE pixels only — the ink, ignoring the
 * transparent surround. Throws when nothing is opaque, so a fully blank asset
 * cannot pass a brightness assertion by having no pixels to disagree with.
 */
export function meanInk(rgba: Buffer): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba.readUInt8(i + 3) < 200) continue;
    sum += (rgba.readUInt8(i) + rgba.readUInt8(i + 1) + rgba.readUInt8(i + 2)) / 3;
    n++;
  }
  if (n === 0) throw new Error("image paints no opaque pixels");
  return sum / n;
}
