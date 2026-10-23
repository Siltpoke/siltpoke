// Canvas size ceiling (spec §7.4, Q7): try 2x, then 1x, then shrink to the
// tightest of the three limits. Thresholds are constants so a browser that
// measures lower can be accommodated in one place.
const MAX_SIDE = 16384;
const MAX_AREA = 16_000_000;

interface ScaleChoice {
  scale: number;
  reduced: boolean;
}

function fits(w: number, h: number, s: number): boolean {
  return w * s <= MAX_SIDE && h * s <= MAX_SIDE && w * h * s * s <= MAX_AREA;
}

export function chooseScale(w: number, h: number): ScaleChoice {
  for (const s of [2, 1]) if (fits(w, h, s)) return { scale: s, reduced: false };
  const tight = Math.min(MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
  return { scale: Math.floor(tight * 100 + 1e-9) / 100, reduced: true };
}

export function scaleLabel(r: ScaleChoice): string {
  if (!r.reduced) return `Rendered at ${r.scale}×`;
  return `Rendered at ${r.scale}× — map too large for a sharp image; the HTML export has no size limit`;
}
