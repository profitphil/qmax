// Builds QMax's logo files from the supplied artwork (brand/qmax-logo-source.jpg: the white wordmark "QMax" with a two-arrow X on a dark background).
//
//   node scripts/make-brand.mjs
//
// - web/public/brand/qma.png     the letters "QMa" as a white shape on a transparent background, used as a CSS mask so they take the page's text colour
// - web/public/brand/qmax-x.svg  the X (two crossing arrows) as a vector, for small spaces
// - web/public/favicon.svg, favicon-32.png, favicon.ico   the X alone, as big as the tab allows (browser tab icon)
// - web/public/apple-touch-icon.png   the X on a dark tile (a phone's home screen wants a solid square)
// - web/public/brand/qmax-avatar-512.png   the same on a plain square, 512 pixels (the Discord bot's picture, the wallet request's icon)
// The X is redrawn as clean vector shapes from measurements of the artwork (its corners and its colours), so it stays sharp at 16 pixels and at 600.
// The letters are cut out of the artwork itself. Needs macOS `sips` (it reads the JPEG and shrinks the letters) and @resvg/resvg-js (already a dependency).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const root = join(import.meta.dirname, "..");
const source = join(root, "brand", "qmax-logo-source.jpg");
const out = join(root, "web", "public");
const tmp = mkdtempSync(join(tmpdir(), "qmax-brand-"));

// ---- the letters: cut out of the artwork -----------------------------------------------------------------------------------------
const bmpPath = join(tmp, "src.bmp");
execFileSync("sips", ["-s", "format", "bmp", source, "--out", bmpPath], { stdio: "ignore" });
const bmp = readFileSync(bmpPath);
const dataAt = bmp.readUInt32LE(10);
const W = bmp.readInt32LE(18);
const Hraw = bmp.readInt32LE(22);
const H = Math.abs(Hraw);
const bpp = bmp.readUInt16LE(28);
const stride = Math.ceil((W * bpp) / 32) * 4;
const lum = (x, y) => {
  const row = Hraw > 0 ? H - 1 - y : y;
  const o = dataAt + row * stride + x * (bpp / 8);
  return 0.2126 * bmp[o + 2] + 0.7152 * bmp[o + 1] + 0.0722 * bmp[o];
};
// where the letters are, with room to spare (the X starts further right)
const BOX = { x0: 270, y0: 410, x1: 1105, y1: 745 };
const alphaOf = (x, y) => Math.max(0, Math.min(1, (lum(x, y) - 45) / (205 - 45)));
let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
for (let y = BOX.y0; y < BOX.y1; y++) for (let x = BOX.x0; x < BOX.x1; x++) if (alphaOf(x, y) > 0.5) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
const pad = 3;
const cx0 = minx - pad, cy0 = miny - pad, cw = maxx - minx + 1 + 2 * pad, ch = maxy - miny + 1 + 2 * pad;
const rgba = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
  const a = alphaOf(cx0 + x, cy0 + y);
  const o = (y * cw + x) * 4;
  rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
  rgba[o + 3] = Math.round(a * 255);
}
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
};
const png = (w, h, px) => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
};
const qmaPath = join(out, "brand", "qma.png");
writeFileSync(qmaPath, png(cw, ch, rgba));
execFileSync("sips", ["-Z", "640", qmaPath], { stdio: "ignore" }); // the letters are shown at under 100 CSS pixels: 640 is plenty, even at 3x
console.log(`letters: ${cw}x${ch} cut out, then shrunk to 640 wide`);

// ---- the X: vector shapes, in the artwork's own units (292 x 301) ----------------------------------------------------------------
// Corners measured from the artwork: each arrow is a flat-ended band that meets the base of a triangular head.
export const X_VIEW = "0 0 292 301";
const upArrow = "M0.5 270 H57.5 L254 68 L276 88 L292 0 L204 15 L225 38 Z"; // "/", bottom left to the head at the top right
const downArrow = "M0.5 31 H57.5 L251 234 L269 216 L286 301 L203 285 L223 261 Z"; // "\", top left to the head at the bottom right
export const X_DEFS = `<linearGradient id="qx-up" gradientUnits="userSpaceOnUse" x1="28" y1="271" x2="268" y2="34"><stop offset="0" stop-color="#0A8AC6"/><stop offset=".5" stop-color="#33AEA8"/><stop offset="1" stop-color="#24C294"/></linearGradient>
<linearGradient id="qx-down" gradientUnits="userSpaceOnUse" x1="30" y1="46" x2="251" y2="260"><stop offset="0" stop-color="#1CBBD8"/><stop offset=".4" stop-color="#28B8B3"/><stop offset=".5" stop-color="#33AFA7"/><stop offset=".6" stop-color="#656A69"/><stop offset=".7" stop-color="#984F52"/><stop offset=".8" stop-color="#B33941"/><stop offset=".9" stop-color="#C82B36"/><stop offset="1" stop-color="#D22230"/></linearGradient>`;
export const X_SHAPES = `<path d="${downArrow}" fill="url(#qx-down)"/><path d="${upArrow}" fill="url(#qx-up)"/>`;

writeFileSync(join(out, "brand", "qmax-x.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${X_VIEW}"><defs>${X_DEFS}</defs>${X_SHAPES}</svg>\n`);

// ---- the X on a dark tile: the home-screen icon ----------------------------------------------------------------------------------
const tile = (size, radius = 0.22) => {
  const s = size * 0.6; // the X takes 60% of the tile
  const k = s / 301;
  const tx = (size - 292 * k) / 2;
  const ty = (size - 301 * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${X_DEFS}</defs><rect width="${size}" height="${size}" rx="${size * radius}" fill="#151724"/><g transform="translate(${tx} ${ty}) scale(${k})">${X_SHAPES}</g></svg>`;
};
writeFileSync(join(out, "apple-touch-icon.png"), new Resvg(tile(180), { fitTo: { mode: "width", value: 180 } }).render().asPng());
// the picture for the Discord bot and the wallet connect request: a plain square (Discord cuts it round itself), big enough for a profile picture
writeFileSync(join(out, "brand", "qmax-avatar-512.png"), new Resvg(tile(512, 0), { fitTo: { mode: "width", value: 512 } }).render().asPng());

// ---- the X alone: the browser tab icon -------------------------------------------------------------------------------------------
// A tab shows the icon at 16 pixels, so the X fills nearly all of it, with no tile around it (its colours read on a light tab and a dark one).
const bare = (size) => {
  const k = (size * 0.96) / 301;
  const tx = (size - 292 * k) / 2;
  const ty = (size - 301 * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${X_DEFS}</defs><g transform="translate(${tx} ${ty}) scale(${k})">${X_SHAPES}</g></svg>`;
};
const renderBare = (size) => new Resvg(bare(size), { fitTo: { mode: "width", value: size } }).render().asPng();
writeFileSync(join(out, "favicon.svg"), bare(64) + "\n");
writeFileSync(join(out, "favicon-32.png"), renderBare(32));
// favicon.ico: some browsers (and anything that asks for /favicon.ico by habit) want it; PNG pictures inside the ICO container, 16, 32 and 48 pixels
const sizes = [16, 32, 48];
const pics = sizes.map((n) => renderBare(n));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((n, i) => {
  const e = 6 + 16 * i;
  head[e] = n; head[e + 1] = n; head[e + 2] = 0; head[e + 3] = 0;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pics[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pics[i].length;
});
writeFileSync(join(out, "favicon.ico"), Buffer.concat([head, ...pics]));
console.log("X mark, favicon.svg, favicon-32.png, favicon.ico, apple-touch-icon.png and qmax-avatar-512.png written");
