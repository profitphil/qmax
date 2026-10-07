import test from "node:test";
import assert from "node:assert/strict";
import { CHART_THEMES, DEFAULT_CHART_THEME, isChartThemeId, paletteOf, rgbOf } from "../src/charttheme.ts";
import type { ChartPalette } from "../src/charttheme.ts";

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const palettes = CHART_THEMES.flatMap((t) => (t.palette ? [[t.id, t.palette as ChartPalette] as const] : []));

test("every scheme has an id that is unique and known, and 'match' is the default without a palette", () => {
  const ids = CHART_THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(isChartThemeId));
  assert.equal(DEFAULT_CHART_THEME, "match");
  assert.equal(paletteOf("match"), null);
  assert.ok(paletteOf("classic"));
  assert.equal(isChartThemeId("neon"), false);
  assert.equal(isChartThemeId(undefined), false);
});

test("every colour is a #rrggbb value", () => {
  for (const [id, p] of palettes) for (const [k, v] of Object.entries(p)) assert.match(v, /^#[0-9a-f]{6}$/i, `${id}.${k}`);
});

test("text, axis labels and both candle colours can be read against the background", () => {
  for (const [id, p] of palettes) {
    assert.ok(contrast(p.fg, p.bg) >= 7, `${id}: text ${contrast(p.fg, p.bg).toFixed(1)}`);
    assert.ok(contrast(p.muted, p.bg) >= 4, `${id}: axis ${contrast(p.muted, p.bg).toFixed(1)}`);
    assert.ok(contrast(p.up, p.bg) >= 3, `${id}: up ${contrast(p.up, p.bg).toFixed(1)}`);
    assert.ok(contrast(p.down, p.bg) >= 3, `${id}: down ${contrast(p.down, p.bg).toFixed(1)}`);
    assert.ok(contrast(p.accent, p.bg) >= 3, `${id}: accent ${contrast(p.accent, p.bg).toFixed(1)}`);
  }
});

test("rising and falling are never the same colour; the blue and orange scheme also differs in brightness, so it holds up for colour blindness", () => {
  for (const [id, p] of palettes) assert.ok(contrast(p.up, p.down) >= 1.1, `${id}: ${contrast(p.up, p.down).toFixed(2)}`);
  const b = paletteOf("bluorange")!;
  assert.ok(contrast(b.up, b.down) >= 1.4, `bluorange: ${contrast(b.up, b.down).toFixed(2)}`);
});

test("rgbOf writes a colour the chart helpers can add transparency to", () => {
  assert.equal(rgbOf("#ffb000"), "rgb(255, 176, 0)");
  assert.equal(rgbOf("#000000"), "rgb(0, 0, 0)");
  assert.throws(() => rgbOf("red"));
});
