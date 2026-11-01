// Makes the launch sting (components/launch-splash.tsx): the booklet breathes,
// its star pops with a warm glow and throws a burst of sparkles, the little
// ring pulses, and everything settles back to the exact splash picture. The
// first frame and the last are the still splash (splash-icon.png on the splash
// colour), so the native splash can hand over to the clip, and the clip to the
// still beneath it, with no visible jump. It ends as soon as the motion does:
// any longer only holds a still in front of an app that is ready. Needs only
// Node and ffmpeg. Run it again whenever splash-icon.png or a splash colour
// changes:
//
//   node scripts/make-splash-sting.mjs assets/images/splash-icon.png assets/video/splash-sting-light.mp4 '#fbf8f4'
//   node scripts/make-splash-sting.mjs assets/images/splash-icon.png assets/video/splash-sting-dark.mp4 '#000000'
//   node scripts/make-splash-sting.mjs <splash-icon.png> <dir> <bg> <size> --frames 0,0.3,0.45   (test PNGs)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const [src, out, bgHex = '#fbf8f4', sizeArg = '960', flag, list] = process.argv.slice(2);
const S0 = 640;                    // the icon's canvas
const SIZE = Number(sizeArg);      // output square
// The last motion (a sparkle's fade) ends at 1.11 s; the clip ends just after.
const FPS = 60, DUR = 1.15, N = Math.round(FPS * DUR);
const TAU = Math.PI * 2;
const bg = [1, 3, 5].map((k) => parseInt(bgHex.slice(k, k + 2), 16) / 255);

// ---------- the icon, premultiplied ----------
const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 }).stdout;
if (!raw || raw.length !== S0 * S0 * 4) throw new Error(`decode failed (${raw?.length} bytes)`);
const P = S0 * S0;
const cR = new Float32Array(P), cG = new Float32Array(P), cB = new Float32Array(P), cA = new Float32Array(P);
for (let i = 0; i < P; i++) {
  const a = raw[4 * i + 3] / 255;
  cA[i] = a; cR[i] = (raw[4 * i] / 255) * a; cG[i] = (raw[4 * i + 1] / 255) * a; cB[i] = (raw[4 * i + 2] / 255) * a;
}

const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const outCubic = (x) => 1 - (1 - x) ** 3;
const inOutCubic = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const outBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
// Rises on [a, b], falls back to zero on [b, c].
const bump = (t, a, b, c) => (t <= b ? outCubic(seg(t, a, b)) : 1 - inOutCubic(seg(t, b, c)));

// ---------- layers: the star (by its coral colour) and the ring (by place) ----------
const starA = new Float32Array(P), starR = new Float32Array(P), starG = new Float32Array(P), starB = new Float32Array(P);
let sw = 0, sx = 0, sy = 0;
for (let i = 0; i < P; i++) {
  const a = cA[i]; if (a < 0.02) continue;
  const r = cR[i] / a, g = cG[i] / a, b = cB[i] / a, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx <= 0 || mx !== r) continue;                       // coral is red-led
  const sat = (mx - mn) / mx;
  let hue = 60 * (((g - b) / (mx - mn || 1)) % 6); if (hue < 0) hue += 360;
  const hueW = hue <= 180 ? 1 - smooth(32, 46, hue) : smooth(336, 350, hue);
  const m = smooth(0.30, 0.50, sat) * hueW * a;
  if (m <= 0) continue;
  starA[i] = m; starR[i] = r * m; starG[i] = g * m; starB[i] = b * m;
  sw += m; sx += m * (i % S0); sy += m * Math.floor(i / S0);
}
const SC = [sx / sw, sy / sw];                               // the star's centre

let rw = 0, rx = 0, ry = 0;                                  // the ring: alpha up and to the right of the star
for (let y = 60; y < 170; y++) for (let x = 490; x < 580; x++) { const a = cA[y * S0 + x] * (1 - starA[y * S0 + x]); rw += a; rx += a * x; ry += a * y; }
const RC = [rx / rw, ry / rw];
const ringA = new Float32Array(P), ringR = new Float32Array(P), ringG = new Float32Array(P), ringB = new Float32Array(P);
for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
  const i = y * S0 + x, d = Math.hypot(x - RC[0], y - RC[1]), k = 1 - smooth(26, 32, d);
  if (k <= 0) continue;
  ringA[i] = cA[i] * k; ringR[i] = cR[i] * k; ringG[i] = cG[i] * k; ringB[i] = cB[i] * k;
}
const IC = [331, 324];                                       // the icon's middle (its visible box)

// Bilinear read of premultiplied planes; outside the canvas is transparent.
const px = [0, 0, 0, 0];
function read(Rp, Gp, Bp, Ap, x, y) {
  px[0] = px[1] = px[2] = px[3] = 0;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const xi = x0 + dx, yi = y0 + dy; if (xi < 0 || yi < 0 || xi >= S0 || yi >= S0) continue;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), i = yi * S0 + xi;
    px[0] += w * Rp[i]; px[1] += w * Gp[i]; px[2] += w * Bp[i]; px[3] += w * Ap[i];
  }
  return px;
}

// ---------- the burst ----------
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(1101);
const COLORS = [[1.0, 0.54, 0.40], [1.0, 0.77, 0.43], [0.78, 0.61, 0.95], [1.0, 0.54, 0.40]];
const burst = Array.from({ length: 16 }, (_, k) => {
  const star = k < 9;
  const ang = -Math.PI / 2 + (k / 16) * TAU + (rand() - 0.5) * 0.5;
  return {
    star, ang, delay: rand() * 0.06,
    dist: star ? 115 + rand() * 95 : 70 + rand() * 80,      // canvas px
    size: star ? 13 + rand() * 8 : 2.8 + rand() * 1.8,       // canvas px
    spin: (rand() - 0.5) * 5, rot: rand() * TAU, col: COLORS[k % COLORS.length],
  };
});

// ---------- one frame ----------
const scale = S0 / SIZE;
const frame = Buffer.alloc(SIZE * SIZE * 3);
const fr = new Float32Array(SIZE * SIZE), fg = new Float32Array(SIZE * SIZE), fb = new Float32Array(SIZE * SIZE);

function render(t) {
  const gs = 1 + 0.05 * bump(t, 0.12, 0.50, 1.00);                                        // the booklet breathes
  const ss = 1 + 0.26 * (t <= 0.5 ? outBack(seg(t, 0.15, 0.50)) : 1 - inOutCubic(seg(t, 0.50, 1.05))); // the star pops
  const glow = bump(t, 0.12, 0.42, 1.05);
  const rs = 1 + 0.5 * bump(t, 0.22, 0.46, 0.95);                                          // the ring pulses
  const glowCol = [1.0, 0.62, 0.45];

  for (let Y = 0; Y < SIZE; Y++) for (let X = 0; X < SIZE; X++) {
    const o = Y * SIZE + X;
    const cx = (X + 0.5) * scale - 0.5, cy = (Y + 0.5) * scale - 0.5;
    const gx = IC[0] + (cx - IC[0]) / gs, gy = IC[1] + (cy - IC[1]) / gs;
    let p = read(cR, cG, cB, cA, gx, gy);
    let r = p[0] + (1 - p[3]) * bg[0], g = p[1] + (1 - p[3]) * bg[1], b = p[2] + (1 - p[3]) * bg[2];
    if (glow > 0.001) {
      const d2 = (gx - SC[0]) ** 2 + (gy - SC[1]) ** 2, k = 0.30 * glow * Math.exp(-d2 / (2 * 85 * 85));
      r += (glowCol[0] - r) * k; g += (glowCol[1] - g) * k; b += (glowCol[2] - b) * k;
    }
    if (ss > 1.0005) {
      p = read(starR, starG, starB, starA, SC[0] + (gx - SC[0]) / ss, SC[1] + (gy - SC[1]) / ss);
      r = p[0] + (1 - p[3]) * r; g = p[1] + (1 - p[3]) * g; b = p[2] + (1 - p[3]) * b;
    }
    if (rs > 1.0005) {
      p = read(ringR, ringG, ringB, ringA, RC[0] + (gx - RC[0]) / rs, RC[1] + (gy - RC[1]) / rs);
      r = p[0] + (1 - p[3]) * r; g = p[1] + (1 - p[3]) * g; b = p[2] + (1 - p[3]) * b;
    }
    fr[o] = r; fg[o] = g; fb[o] = b;
  }

  // Sparkles: four-point stars and dots flung out from the star.
  for (const s of burst) {
    const q = seg(t, 0.28 + s.delay, 1.05 + s.delay);
    if (q <= 0 || q >= 1) continue;
    const alpha = smooth(0, 0.08, q) * (1 - smooth(0.55, 1, q));
    const reach = s.dist * outCubic(q);
    const ccx = SC[0] + Math.cos(s.ang) * reach, ccy = SC[1] + Math.sin(s.ang) * reach;
    // into output pixels, through the same breath as the booklet
    const X0 = (IC[0] + (ccx - IC[0]) * gs + 0.5) / scale - 0.5, Y0 = (IC[1] + (ccy - IC[1]) * gs + 0.5) / scale - 0.5;
    const rad = (s.size * (1 - 0.55 * q)) / scale, rot = s.rot + s.spin * q;
    const cos = Math.cos(-rot), sin = Math.sin(-rot), box = Math.ceil(rad + 2);
    for (let Y = Math.max(0, Math.floor(Y0) - box); Y <= Math.min(SIZE - 1, Math.floor(Y0) + box); Y++) {
      for (let X = Math.max(0, Math.floor(X0) - box); X <= Math.min(SIZE - 1, Math.floor(X0) + box); X++) {
        const dx = X - X0, dy = Y - Y0;
        let cover;
        if (s.star) {
          const u = Math.abs((dx * cos - dy * sin) / rad), v = Math.abs((dx * sin + dy * cos) / rad);
          const f = u ** 0.6 + v ** 0.6;
          cover = 1 - smooth(0.86, 1.04, f);
        } else {
          cover = 1 - smooth(rad - 0.7, rad + 0.7, Math.hypot(dx, dy));
        }
        const k = cover * alpha; if (k <= 0) continue;
        const o = Y * SIZE + X;
        fr[o] += (s.col[0] - fr[o]) * k; fg[o] += (s.col[1] - fg[o]) * k; fb[o] += (s.col[2] - fb[o]) * k;
      }
    }
  }

  for (let o = 0; o < SIZE * SIZE; o++) {
    frame[3 * o] = Math.round(255 * Math.min(1, Math.max(0, fr[o])));
    frame[3 * o + 1] = Math.round(255 * Math.min(1, Math.max(0, fg[o])));
    frame[3 * o + 2] = Math.round(255 * Math.min(1, Math.max(0, fb[o])));
  }
  return frame;
}

// ---------- output ----------
console.error(`star centre ${SC.map((v) => v.toFixed(1))}, ring centre ${RC.map((v) => v.toFixed(1))}`);
if (flag === '--frames') {
  mkdirSync(out, { recursive: true });
  for (const s of list.split(',').map(Number)) {
    const file = path.join(out, `sting-${s.toFixed(2)}s.png`);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SIZE}x${SIZE}`, '-i', '-', file], { input: render(s) });
    console.log(file);
  }
} else {
  // BT.709 matrix both in the conversion and in the tags, so players turn the
  // splash colour back into the same RGB the native splash draws.
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SIZE}x${SIZE}`, '-r', String(FPS), '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-x264-params', 'mbtree=0:ipratio=1.0:pbratio=1.0:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 0; f < N; f++) {
    if (!ff.stdin.write(Buffer.from(render(f / FPS)))) await new Promise((resolve) => ff.stdin.once('drain', resolve));
  }
  ff.stdin.end();
  await new Promise((resolve) => ff.on('close', resolve));
  console.log(`${N} frames (${DUR} s at ${FPS} fps) -> ${out}`);
}
