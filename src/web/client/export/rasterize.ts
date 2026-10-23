// SVG → PNG through <img> + canvas. Browser-only; proven by the Task 13 e2e.

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** The SVG's embedded `data:` @font-face rules live in the image's own document,
 * which `document.fonts.ready` does not cover, and `img.decode()` does not promise
 * they are applied (Safari/Firefox can paint the fallback font first). A throwaway
 * 1×1 draw makes the engine lay out the text; a frame later the real draw uses the
 * loaded faces. */
async function warmFonts(img: HTMLImageElement): Promise<void> {
  const warm = document.createElement("canvas");
  warm.width = 1;
  warm.height = 1;
  warm.getContext("2d")?.drawImage(img, 0, 0, 1, 1);
  await nextFrame();
  await img.decode();
}

/** The export paints an opaque background, so a fully transparent pixel means
 * the draw failed — Safari returns a blank (not null) PNG past its canvas limit. */
function assertPainted(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const points: Array<[number, number]> = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, h >> 1]];
  for (const [x, y] of points) {
    if (ctx.getImageData(x, y, 1, 1).data[3] === 0) throw new Error("canvas produced a blank image (over the size limit?)");
  }
}

export async function rasterize(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  await document.fonts.ready;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    await warmFonts(img);
    const canvas = document.createElement("canvas");
    // Floor, not round: chooseScale checks the unrounded size against the limits,
    // and rounding up could push the area just past them.
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    assertPainted(ctx, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob || blob.size === 0) throw new Error("canvas produced no image (over the size limit?)");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
