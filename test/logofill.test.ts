import test from "node:test";
import assert from "node:assert/strict";
import { roundLogoFill } from "../src/logofill.ts";

type Rgba = [number, number, number, number];
const W = 96;

/** A W by W picture: `bg` everywhere, then `paint(x, y, d)` (d is the distance from the centre) where it returns a colour. */
function picture(bg: Rgba, paint: (x: number, y: number, d: number) => Rgba | null, size = W) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const c = paint(x, y, d) ?? bg;
      px.set(c, (y * size + x) * 4);
    }
  }
  return px;
}
const TEAL: Rgba = [29, 58, 68, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const NONE: Rgba = [0, 0, 0, 0];
const disc = (r: number, ring: Rgba = TEAL, inner: Rgba = [230, 140, 40, 255]) => (_x: number, _y: number, d: number): Rgba | null => (d > r ? null : d > r * 0.78 ? ring : inner);

test("a round logo on white corners is a disc, filled with the colour of its rim", () => {
  const r = roundLogoFill(picture(WHITE, disc(W / 2)), W, W);
  assert.ok(r);
  assert.equal(r.fill, "#1d3a44");
  assert.ok(r.radius > 0.97 && r.radius <= 1);
});

test("a round logo on see-through corners is one too", () => {
  const r = roundLogoFill(picture(NONE, disc(W / 2, [250, 198, 55, 255])), W, W);
  assert.equal(r?.fill, "#fac637");
});

test("a disc with a margin round it reports its smaller radius", () => {
  const r = roundLogoFill(picture(WHITE, disc(W * 0.4)), W, W);
  assert.ok(r);
  assert.ok(r.radius > 0.75 && r.radius < 0.85, `radius ${r.radius}`);
});

test("a disc on a plain coloured square is a disc (its square can be dropped for the rim's colour)", () => {
  const r = roundLogoFill(picture([19, 18, 23, 255], disc(W / 2, [121, 246, 251, 255])), W, W);
  assert.equal(r?.fill, "#79f6fb");
});

test("the colour is the one most of the rim has, not an average of two", () => {
  const twoTone = (_x: number, _y: number, d: number): Rgba | null => (d > W / 2 ? null : d > (W / 2) * 0.78 ? (_x < W * 0.8 ? [0, 229, 255, 255] : [255, 0, 0, 255]) : [10, 10, 10, 255]);
  const r = roundLogoFill(picture(NONE, twoTone), W, W);
  assert.equal(r?.fill, "#00e5ff");
});

test("a picture that fills its whole square is not a round logo", () => {
  assert.equal(roundLogoFill(picture(WHITE, () => [40, 90, 200, 255]), W, W), null);
});

test("a small mark on white is not a round logo", () => {
  assert.equal(roundLogoFill(picture(WHITE, (_x, _y, d) => (d < W * 0.12 ? TEAL : null)), W, W), null);
});

test("a shape that is not round is not a round logo", () => {
  // a wide rounded bar
  assert.equal(roundLogoFill(picture(WHITE, (x, y) => (Math.abs(x - W / 2) < W * 0.48 && Math.abs(y - W / 2) < W * 0.2 ? TEAL : null)), W, W), null);
});

test("corners of different colours mean there is no plain background", () => {
  const px = picture(WHITE, disc(W / 2));
  px.set([255, 0, 0, 255], (0 * W + 0) * 4);
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) px.set([255, 0, 0, 255], (dy * W + dx) * 4);
  assert.equal(roundLogoFill(px, W, W), null);
});

test("a picture too small or too short to read is left alone", () => {
  assert.equal(roundLogoFill(new Uint8ClampedArray(8 * 8 * 4), 8, 8), null);
  assert.equal(roundLogoFill(new Uint8ClampedArray(10), W, W), null);
});
