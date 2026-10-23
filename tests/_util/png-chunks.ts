// Minimal PNG chunk reader for tests. Does NOT verify CRCs: it only walks the
// length/type framing, which is all the export tests need (which chunk types
// exist, what the IHDR size is). Malformed input throws rather than guessing.
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  type: string;
  dataStart: number;
  length: number;
}

function walkChunks(bytes: Uint8Array): Chunk[] {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG: bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new Error("truncated PNG: partial chunk header");
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (pos + 12 + length > bytes.length) throw new Error(`truncated PNG: ${type} overruns input`);
    chunks.push({ type, dataStart: pos + 8, length });
    pos += 12 + length; // length + type + data + crc
    if (type === "IEND") {
      // Bytes after IEND are ignored by decoders but could carry anything —
      // a privacy assertion over the chunk list must not miss them.
      if (pos !== bytes.length) throw new Error(`PNG has ${bytes.length - pos} trailing byte(s) after IEND`);
      return chunks;
    }
  }
  throw new Error("truncated PNG: no IEND");
}

export function pngChunkTypes(bytes: Uint8Array): string[] {
  return walkChunks(bytes).map((c) => c.type);
}

export function pngSize(bytes: Uint8Array): { w: number; h: number } {
  const ihdr = walkChunks(bytes)[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.length < 8) throw new Error("PNG: first chunk is not IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(ihdr.dataStart), h: view.getUint32(ihdr.dataStart + 4) };
}
