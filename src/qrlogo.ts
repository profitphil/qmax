import QRCode from "qrcode";

/**
 * A QR code with the QMax X in the middle, as SVG (the same picture serves the website, as an image of any size, and the Discord bot, which turns it into a PNG).
 * The middle of a QR code can be covered because the code carries repair data: at the "Q" level up to a quarter of it can be lost and it still reads, and the
 * plate under the X hides about 6% of it.
 */

/** The X mark's two arrows (the same shapes as web/public/brand/qmax-x.svg), in a box 292 wide and 301 high. */
const X_BOX = { w: 292, h: 301 };
const X_DEFS =
  '<linearGradient id="qrx-up" gradientUnits="userSpaceOnUse" x1="28" y1="271" x2="268" y2="34"><stop offset="0" stop-color="#0A8AC6"/><stop offset=".5" stop-color="#33AEA8"/><stop offset="1" stop-color="#24C294"/></linearGradient>' +
  '<linearGradient id="qrx-down" gradientUnits="userSpaceOnUse" x1="30" y1="46" x2="251" y2="260"><stop offset="0" stop-color="#1CBBD8"/><stop offset=".4" stop-color="#28B8B3"/><stop offset=".5" stop-color="#33AFA7"/><stop offset=".6" stop-color="#656A69"/><stop offset=".7" stop-color="#984F52"/><stop offset=".8" stop-color="#B33941"/><stop offset=".9" stop-color="#C82B36"/><stop offset="1" stop-color="#D22230"/></linearGradient>';
const X_SHAPES =
  '<path d="M0.5 31 H57.5 L251 234 L269 216 L286 301 L203 285 L223 261 Z" fill="url(#qrx-down)"/>' +
  '<path d="M0.5 270 H57.5 L254 68 L276 88 L292 0 L204 15 L225 38 Z" fill="url(#qrx-up)"/>';

/**
 * `text` as a QR code in black on white with a quiet margin of `margin` modules, the X on a white plate in the centre. `px` gives the picture a size of its own
 * (a PNG renderer needs one); without it the SVG scales to whatever it is shown at.
 */
export function qrWithLogo(text: string, o: { px?: number; margin?: number } = {}): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "Q" });
  const n = qr.modules.size;
  const data = qr.modules.data as ArrayLike<number>;
  const m = o.margin ?? 2;
  const total = n + 2 * m;

  // the dark modules, each run along a row as one rectangle
  let d = "";
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!data[y * n + x]) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < n && data[y * n + x]) x++;
      d += `M${x0 + m} ${y + m}h${x - x0}v1h${x0 - x}z`;
    }
  }

  // the X, a fifth of the code's width, on a white plate a little bigger than it
  const logo = n * 0.2;
  const k = logo / X_BOX.h;
  const plate = logo * 1.3;
  const c = total / 2;
  const size = o.px ? ` width="${o.px}" height="${o.px}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${size}>` +
    `<defs>${X_DEFS}</defs>` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${d}" fill="#000" shape-rendering="crispEdges"/>` +
    `<rect x="${c - plate / 2}" y="${c - plate / 2}" width="${plate}" height="${plate}" rx="${plate * 0.2}" fill="#fff"/>` +
    `<g transform="translate(${c - (X_BOX.w * k) / 2} ${c - (X_BOX.h * k) / 2}) scale(${k})">${X_SHAPES}</g>` +
    `</svg>`
  );
}
