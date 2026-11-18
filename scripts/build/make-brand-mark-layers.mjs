// Makes the layers of the web's animated brand mark (src/components/brand/BrandMark.tsx),
// the sidebar's copy of the app's launch sting (ugc-mobile/scripts/make-splash-sting.mjs):
// the app icon itself, and its star and dot cut out of the transparent splash picture on
// their own, so each can grow from its own centre over the icon. The app icon is the
// splash picture scaled by exactly 1.6 (640 to 1024 px, no offset), so a layer cut from
// the splash canvas lines up with the icon when both are drawn the same size.
// Run it again whenever the app icon or the splash picture changes:
//
//   node scripts/build/make-brand-mark-layers.mjs
//
// It prints the star's and the dot's centres as percentages of the tile, which
// BrandMark.tsx keeps as STAR_CENTRE and DOT_CENTRE.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON = path.join(ROOT, 'ugc-mobile/assets/images/icon.png');
const SPLASH = path.join(ROOT, 'ugc-mobile/assets/images/splash-icon.png');
const OUT = path.join(ROOT, 'src/components/brand');
// 3x the 40px tile.
const SIZE = 120;

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const { data, info } = await sharp(SPLASH).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const S0 = info.width;
if (S0 !== 640 || info.height !== 640) throw new Error(`splash picture is ${info.width}x${info.height}, expected 640x640`);
const P = S0 * S0;

// The star, by its coral colour, as make-splash-sting.mjs finds it.
const star = Buffer.alloc(P * 4);
const starWeight = new Float32Array(P);
let sw = 0, sx = 0, sy = 0;
for (let i = 0; i < P; i++) {
  const a = data[4 * i + 3] / 255;
  if (a < 0.02) continue;
  const r = data[4 * i] / 255, g = data[4 * i + 1] / 255, b = data[4 * i + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx <= 0 || mx !== r) continue;
  const sat = (mx - mn) / mx;
  let hue = 60 * (((g - b) / (mx - mn || 1)) % 6);
  if (hue < 0) hue += 360;
  const hueW = hue <= 180 ? 1 - smooth(32, 46, hue) : smooth(336, 350, hue);
  const m = smooth(0.3, 0.5, sat) * hueW * a;
  if (m <= 0) continue;
  starWeight[i] = m;
  star[4 * i] = data[4 * i];
  star[4 * i + 1] = data[4 * i + 1];
  star[4 * i + 2] = data[4 * i + 2];
  star[4 * i + 3] = Math.round(255 * m);
  sw += m; sx += m * (i % S0); sy += m * Math.floor(i / S0);
}
const starCentre = [sx / sw, sy / sw];

// The dot, by its place up and to the right of the star.
let rw = 0, rx = 0, ry = 0;
for (let y = 60; y < 170; y++) {
  for (let x = 490; x < 580; x++) {
    const i = y * S0 + x;
    const a = (data[4 * i + 3] / 255) * (1 - starWeight[i]);
    rw += a; rx += a * x; ry += a * y;
  }
}
const dotCentre = [rx / rw, ry / rw];
const dot = Buffer.alloc(P * 4);
for (let y = 0; y < S0; y++) {
  for (let x = 0; x < S0; x++) {
    const i = y * S0 + x;
    const k = 1 - smooth(26, 32, Math.hypot(x - dotCentre[0], y - dotCentre[1]));
    if (k <= 0) continue;
    dot[4 * i] = data[4 * i];
    dot[4 * i + 1] = data[4 * i + 1];
    dot[4 * i + 2] = data[4 * i + 2];
    dot[4 * i + 3] = Math.round(data[4 * i + 3] * k);
  }
}

const png = { compressionLevel: 9 };
const raw = { raw: { width: S0, height: S0, channels: 4 } };
await sharp(ICON).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png(png).toFile(path.join(OUT, 'magic-booklet-icon.png'));
await sharp(star, raw).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png(png).toFile(path.join(OUT, 'magic-booklet-star.png'));
await sharp(dot, raw).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png(png).toFile(path.join(OUT, 'magic-booklet-dot.png'));

const percent = ([x, y]) => `{ x: ${((100 * x) / S0).toFixed(2)}, y: ${((100 * y) / S0).toFixed(2)} }`;
console.log(`STAR_CENTRE = ${percent(starCentre)}`);
console.log(`DOT_CENTRE = ${percent(dotCentre)}`);
