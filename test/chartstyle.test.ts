import test from "node:test";
import assert from "node:assert/strict";
import { CHART_THEMES } from "../src/charttheme.ts";
import { DEFAULT_STYLE, FONTS, fontStack, hexOf, isCustomised, mix, parseRgb, resolveStyle, sanitizeStyle } from "../src/chartstyle.ts";
import type { BaseColors, ChartStyle } from "../src/chartstyle.ts";

const PAGE: BaseColors = { muted: "rgb(133, 140, 149)", fg: "rgb(221, 224, 228)", surface: "rgb(26, 28, 31)", surface3: "rgb(45, 49, 53)", grid: "rgb(148, 163, 184)", up: "rgb(60, 184, 120)", down: "rgb(229, 88, 79)", accent: "rgb(90, 166, 238)" };
const style = (o: Partial<ChartStyle> = {}): ChartStyle => ({ ...DEFAULT_STYLE, ...o });

test("nothing stored, or junk stored, is the plain default", () => {
  assert.deepEqual(sanitizeStyle(undefined), DEFAULT_STYLE);
  assert.deepEqual(sanitizeStyle(null), DEFAULT_STYLE);
  assert.deepEqual(sanitizeStyle("<script>"), DEFAULT_STYLE);
  assert.deepEqual(sanitizeStyle(42), DEFAULT_STYLE);
  assert.deepEqual(sanitizeStyle([]), DEFAULT_STYLE);
  assert.equal(isCustomised(DEFAULT_STYLE), false);
});

test("a colour is #rrggbb and nothing else: anything that could carry markup or css is dropped", () => {
  const s = sanitizeStyle({ bg: "#AbCdEf", up: "red", down: "url(javascript:alert(1))", line: "#12345", grid: "#12345g", text: "rgb(1,2,3)", crosshair: "#00ff00; background:red", wickUp: 12 });
  assert.equal(s.bg, "#abcdef");
  for (const k of ["up", "down", "line", "grid", "text", "crosshair", "wickUp"] as const) assert.equal(s[k], null, k);
});

test("numbers are rounded and held to their range, and names must be ours", () => {
  const s = sanitizeStyle({ lineWidth: 99, fontSize: 2, volumeOpacity: 150.6, font: "comic-sans", gridLine: "wavy", gradientDir: "spiral", preset: "neon" });
  assert.equal(s.lineWidth, 4);
  assert.equal(s.fontSize, 10);
  assert.equal(s.volumeOpacity, 90);
  assert.equal(s.font, "system");
  assert.equal(s.gridLine, "default");
  assert.equal(s.gradientDir, "vertical");
  assert.equal(s.preset, "match");
  assert.equal(sanitizeStyle({ lineWidth: NaN }).lineWidth, 2);
  assert.equal(sanitizeStyle({ fontSize: "14" }).fontSize, 12);
  assert.equal(sanitizeStyle({ lineWidth: 1.4 }).lineWidth, 1);
  assert.equal(sanitizeStyle({ volumeOpacity: 3 }).volumeOpacity, 10);
});

test("a good style survives a round trip through storage", () => {
  const mine = style({ preset: "midnight", bg: "#101820", bgGradient: true, bg2: "#203040", gradientDir: "diagonal", up: "#00ff88", down: "#ff0044", wicksMatch: false, wickUp: "#ffffff", hollowUp: true, lineWidth: 3, gridLine: "dashed", gridVert: false, volumeOpacity: 30, watermark: false, font: "mono", fontSize: 14 });
  assert.deepEqual(sanitizeStyle(JSON.parse(JSON.stringify(mine))), mine);
  assert.equal(isCustomised(mine), true);
  assert.equal(isCustomised(style({ preset: "classic" })), true);
});

test("with nothing chosen the chart is the page's: its colours, the original look, and no frame of its own", () => {
  const r = resolveStyle(PAGE, DEFAULT_STYLE);
  assert.deepEqual({ ...r.colors, crosshair: undefined }, { ...PAGE, crosshair: undefined });
  assert.equal(r.colors.crosshair, PAGE.muted);
  assert.equal(r.bgCss, null);
  assert.equal(r.gradient, null);
  assert.equal(r.wickUp, PAGE.up);
  assert.equal(r.wickDown, PAGE.down);
  assert.equal(r.hollowUp, false);
  assert.equal(r.fontSize, 12);
  assert.equal(r.lineWidth, 2);
  assert.equal(r.volumeOpacity, 0.45);
  assert.equal(r.fontFamily, FONTS[0].stack);
});

test("a scheme replaces the page's colours and gives the chart a frame of its own", () => {
  const r = resolveStyle(PAGE, style({ preset: "amber" }));
  assert.equal(r.colors.up, "rgb(255, 176, 0)");
  assert.equal(r.colors.surface, "rgb(13, 10, 0)");
  assert.equal(r.bgCss, "rgb(13, 10, 0)");
});

test("the person's own colours go over the scheme", () => {
  const r = resolveStyle(PAGE, style({ preset: "amber", up: "#00ff00", bg: "#000000", line: "#ff00ff", grid: "#336699", text: "#ffffff", crosshair: "#ffff00" }));
  assert.equal(r.colors.up, "rgb(0, 255, 0)");
  assert.equal(r.colors.down, "rgb(194, 84, 0)"); // not chosen: still the scheme's
  assert.equal(r.colors.surface, "rgb(0, 0, 0)");
  assert.equal(r.colors.accent, "rgb(255, 0, 255)");
  assert.equal(r.colors.grid, "rgb(51, 102, 153)");
  assert.equal(r.colors.fg, "rgb(255, 255, 255)");
  assert.equal(r.colors.crosshair, "rgb(255, 255, 0)");
  assert.equal(r.bgCss, "rgb(0, 0, 0)");
  // a colour over the page's own colours (no scheme) gives a frame too
  assert.equal(resolveStyle(PAGE, style({ bg: "#112233" })).bgCss, "rgb(17, 34, 51)");
});

test("a gradient runs from the background to a second colour, in the chosen direction", () => {
  const v = resolveStyle(PAGE, style({ bg: "#000000", bgGradient: true, bg2: "#ffffff" }));
  assert.equal(v.bgCss, "linear-gradient(180deg, rgb(0, 0, 0), rgb(255, 255, 255))");
  assert.deepEqual(v.gradient, { from: "rgb(0, 0, 0)", to: "rgb(255, 255, 255)", dir: "vertical" });
  assert.match(resolveStyle(PAGE, style({ bg: "#000000", bgGradient: true, bg2: "#ffffff", gradientDir: "horizontal" })).bgCss!, /^linear-gradient\(90deg,/);
  assert.match(resolveStyle(PAGE, style({ bg: "#000000", bgGradient: true, bg2: "#ffffff", gradientDir: "diagonal" })).bgCss!, /^linear-gradient\(135deg,/);
  // no second colour chosen: it fades towards the line colour, so the gradient is always visible
  const auto = resolveStyle(PAGE, style({ bgGradient: true }));
  assert.ok(auto.gradient && auto.gradient.from === PAGE.surface && auto.gradient.to !== auto.gradient.from);
  assert.match(auto.bgCss!, /^linear-gradient\(180deg, rgb\(26, 28, 31\), rgb\(/);
});

test("wicks follow the candle unless they were given colours of their own", () => {
  assert.equal(resolveStyle(PAGE, style({ up: "#00ff00", wickUp: "#ffffff" })).wickUp, "rgb(0, 255, 0)");
  const own = resolveStyle(PAGE, style({ up: "#00ff00", down: "#ff0000", wicksMatch: false, wickUp: "#ffffff" }));
  assert.equal(own.wickUp, "rgb(255, 255, 255)");
  assert.equal(own.wickDown, "rgb(255, 0, 0)"); // no colour of its own for this one: the candle's
});

test("every typeface has a stack that starts with a real name and ends with a generic family, and an unknown one is the system's", () => {
  for (const f of FONTS) assert.match(fontStack(f.id), /(sans-serif|serif|monospace|system-ui)$/);
  assert.equal(fontStack("nope" as never), FONTS[0].stack);
  assert.equal(new Set(FONTS.map((f) => f.id)).size, FONTS.length);
});

test("every scheme resolves to colours the chart can add transparency to (rgb)", () => {
  for (const t of CHART_THEMES) {
    const r = resolveStyle(PAGE, style({ preset: t.id }));
    for (const v of Object.values(r.colors)) assert.match(v, /^rgb\(\d+, \d+, \d+\)$/, t.id);
  }
});

test("colour helpers", () => {
  assert.deepEqual(parseRgb("rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseRgb("rgba(10 20 30 / 0.5)"), [10, 20, 30]);
  assert.deepEqual(parseRgb("#0a0b0c"), [10, 11, 12]);
  assert.equal(parseRgb("blue"), null);
  assert.equal(hexOf("rgb(255, 176, 0)"), "#ffb000");
  assert.equal(hexOf("rgba(0, 0, 0, 0.3)"), "#000000");
  assert.equal(hexOf("garbage"), "#000000");
  assert.equal(mix("rgb(0, 0, 0)", "rgb(100, 200, 50)", 0.5), "rgb(50, 100, 25)");
  assert.equal(mix("rgb(0, 0, 0)", "rgb(255, 255, 255)", 0), "rgb(0, 0, 0)");
});
