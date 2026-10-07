/**
 * Round logos on a square badge. Many asset logos are a disc (a round picture) sitting on a plain square: white, or nothing at all. Drawn as they are, the white
 * corners show as a white square around the picture, and the see-through ones as a grey one. `roundLogoFill` looks at a logo's pixels and says whether it is a
 * disc on a plain background and, if so, how big the disc is and which colour its rim is, so the badge can be filled with that colour behind the disc instead.
 */

export interface RoundLogo {
  /** The colour of the disc's rim (the one that most of its outer edge has), as `#rrggbb`. */
  fill: string;
  /** The disc's radius as a share of half the picture's width (1 is a disc that touches the edges). */
  radius: number;
}

const OPAQUE = 40; // an alpha below this is "nothing there"
const DIRECTIONS = 24;

/**
 * `px` is RGBA, row by row (a canvas's `getImageData().data`), `w` by `h` pixels. Returns null for a picture that is not a disc on a plain background: one that
 * fills its whole square, a small mark on white, a shape that is not round.
 */
export function roundLogoFill(px: ArrayLike<number>, w: number, h: number): RoundLogo | null {
  if (w < 16 || h < 16 || px.length < w * h * 4) return null;
  const at = (x: number, y: number) => {
    const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]] as const;
  };

  // What the background is: from the four corners, nothing, or one plain colour.
  const samples: (readonly number[])[] = [];
  for (const [cx, cy] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]] as const) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) samples.push(at(cx + dx, cy + dy));
  }
  const clear = samples.filter((s) => s[3] < OPAQUE).length;
  let bg: readonly [number, number, number] | null = null; // null: see-through
  if (clear < samples.length * 0.9) {
    const solid = samples.filter((s) => s[3] >= 200);
    if (solid.length < samples.length * 0.9) return null; // half see-through: not a plain background
    const med = (k: number) => [...solid].map((s) => s[k]).sort((a, b) => a - b)[Math.floor(solid.length / 2)];
    bg = [med(0), med(1), med(2)];
    if (solid.some((s) => Math.hypot(s[0] - bg![0], s[1] - bg![1], s[2] - bg![2]) > 40)) return null; // the corners differ
  }
  const isBg = (x: number, y: number) => {
    const p = at(x, y);
    if (p[3] < OPAQUE) return true;
    return bg !== null && p[3] >= 200 && Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) < 38;
  };

  // The disc's size: from the edge of the picture inwards along each direction to the first two pixels that are not background.
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.min(w, h) / 2;
  const radii: number[] = [];
  for (let k = 0; k < DIRECTIONS; k++) {
    const a = (k / DIRECTIONS) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let found = -1;
    for (let d = Math.hypot(w, h) / 2; d > 0; d -= 0.5) {
      const x = Math.floor(cx + ux * d);
      const y = Math.floor(cy + uy * d);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (!isBg(x, y) && !isBg(Math.floor(cx + ux * (d - 1)), Math.floor(cy + uy * (d - 1)))) {
        found = d;
        break;
      }
    }
    if (found < 0) return null;
    radii.push(found);
  }
  const r = radii.reduce((s, x) => s + x, 0) / radii.length;
  if (r < half * 0.6) return null; // a small mark, not a picture that fills its badge
  if (Math.max(...radii) > half * 1.02) return null; // runs to a corner: a square picture
  if (radii.some((x) => Math.abs(x - r) > r * 0.06)) return null; // not round

  // Everything outside the disc is background, and the disc reaches its rim all round (it is not a ring or a thin outline of nothing).
  let outside = 0;
  let outsideBg = 0;
  let rim = 0;
  let rimInk = 0;
  const colours = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r * 1.06) {
        outside++;
        if (isBg(x, y)) outsideBg++;
      } else if (d >= r * 0.84 && d <= r * 0.95) {
        rim++;
        const p = at(x, y);
        if (!isBg(x, y)) {
          rimInk++;
          // the most common colour of the rim, with near colours counted together
          const key = (p[0] >> 4) * 256 + (p[1] >> 4) * 16 + (p[2] >> 4);
          const c = colours.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          c.n++;
          c.r += p[0];
          c.g += p[1];
          c.b += p[2];
          colours.set(key, c);
        }
      }
    }
  }
  if (outside > 0 && outsideBg / outside < 0.95) return null;
  if (rim === 0 || rimInk / rim < 0.9) return null;
  let top: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of colours.values()) if (!top || c.n > top.n) top = c;
  if (!top) return null;
  const hex = (v: number) => Math.round(v / top!.n).toString(16).padStart(2, "0");
  return { fill: `#${hex(top.r)}${hex(top.g)}${hex(top.b)}`, radius: Math.min(1, r / half) };
}
