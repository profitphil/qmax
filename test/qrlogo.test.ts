import test from "node:test";
import assert from "node:assert/strict";
import { qrWithLogo } from "../src/qrlogo.ts";

const URI = `wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}&expiryTimestamp=1791400000`;

test("the QR code is an SVG with the QMax X on a white plate in the middle", () => {
  const svg = qrWithLogo(URI);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 (\d+) \1"/); // square
  assert.ok(svg.includes("qrx-up") && svg.includes("qrx-down"), "the two arrows of the X");
  assert.ok(svg.includes('fill="#fff"'), "a white plate under it");
  assert.ok(!/ width=/.test(svg.split(">")[0]), "no size of its own unless asked, so it scales to where it is shown");
});

test("a size can be asked for (a PNG renderer needs one)", () => {
  const head = qrWithLogo(URI, { px: 420 }).split(">")[0];
  assert.ok(head.includes('width="420"') && head.includes('height="420"'));
});

test("the same text gives the same picture, and different text a different one", () => {
  assert.equal(qrWithLogo(URI), qrWithLogo(URI));
  assert.notEqual(qrWithLogo(URI), qrWithLogo(URI + "x"));
});
