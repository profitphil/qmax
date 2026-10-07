import { roundLogoFill } from "../src/logofill.ts";
import type { RoundLogo } from "../src/logofill.ts";

/** What each logo turned out to be, by its address: a disc on a plain background (with the fill for its badge), or not. A logo is looked at once. */
const seen = new Map<string, RoundLogo | null>();

/** undefined: not looked at yet. null: not a round logo (or it could not be read). */
export const roundOf = (src: string): RoundLogo | null | undefined => seen.get(src);

/** Looks at a logo that has just loaded (the same picture the badge shows, drawn small onto a canvas), and remembers what it is. */
export function noteLogo(src: string, img: HTMLImageElement): RoundLogo | null {
  if (seen.has(src)) return seen.get(src) ?? null;
  let found: RoundLogo | null = null;
  try {
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long > 0) {
      const k = Math.min(1, 128 / long);
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        found = roundLogoFill(ctx.getImageData(0, 0, w, h).data, w, h);
      }
    }
  } catch {
    found = null; // a picture the page may not read: it is shown as it is
  }
  seen.set(src, found);
  return found;
}
