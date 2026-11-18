import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import BrandMark, { brandMarkSparks, DOT_CENTRE, replayBrandMark, STAR_CENTRE } from '@/components/brand/BrandMark';
import { mulberry32 } from '@/lib/feed-thompson';

const ROOT = process.cwd();
// The script that makes the app's launch clip: the web's sting is a copy of its motion.
const STING_SCRIPT = readFileSync(path.join(ROOT, 'ugc-mobile/scripts/make-splash-sting.mjs'), 'utf8');
const GLOBALS_CSS = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');

function scriptMatch(pattern: RegExp): RegExpMatchArray {
  const match = STING_SCRIPT.match(pattern);
  if (!match) throw new Error(`make-splash-sting.mjs no longer has ${pattern}: update the web's brand mark with it`);
  return match;
}

const DURATION = Number(scriptMatch(/DUR = ([\d.]+)/)[1]);
/** A time of the script's, as a keyframe percentage the way globals.css writes it. */
const percent = (seconds: number) => `${Number(((seconds / DURATION) * 100).toFixed(2))}%`;

function keyframes(name: string): string {
  const match = GLOBALS_CSS.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`globals.css has no @keyframes ${name}`);
  return match[1];
}

/** The script's own burst, evaluated from its source with its seed. */
function scriptBurst() {
  const seed = Number(scriptMatch(/const rand = mulberry32\((\d+)\);/)[1]);
  const colours = JSON.parse(scriptMatch(/const COLORS = (\[[^;]+\]);/)[1]) as number[][];
  const burst = scriptMatch(/const burst = (Array\.from\(\{ length: \d+ \}, \(_, k\) => \{[\s\S]*?\n\}\));/)[1];
  type ScriptSpark = { star: boolean; ang: number; delay: number; dist: number; size: number; spin: number; rot: number; col: number[] };
  const evaluate = new Function('rand', 'TAU', 'COLORS', `return ${burst};`) as (rand: () => number, tau: number, colours: number[][]) => ScriptSpark[];
  return evaluate(mulberry32(seed), Math.PI * 2, colours);
}

async function alphaCentre(file: string) {
  const { data, info } = await sharp(path.join(ROOT, 'src/components/brand', file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let weight = 0, x = 0, y = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const alpha = data[4 * i + 3];
    weight += alpha;
    x += alpha * ((i % info.width) + 0.5);
    y += alpha * (Math.floor(i / info.width) + 0.5);
  }
  return { x: (100 * x) / weight / info.width, y: (100 * y) / weight / info.height };
}

describe('brand mark against the app launch sting', () => {
  it('throws the script\'s burst: same seed, order of draws, directions, delays and turns', () => {
    const script = scriptBurst();
    const sparks = brandMarkSparks();
    expect(sparks).toHaveLength(script.length);

    const reach = Math.hypot(sparks[0].x, sparks[0].y) / script[0].dist;
    const starGrowth = sparks[0].radius / script[0].size;
    const dotIndex = script.findIndex((spark) => !spark.star);
    const dotGrowth = sparks[dotIndex].radius / script[dotIndex].size;
    script.forEach((expected, k) => {
      const spark = sparks[k];
      expect(spark.shape).toBe(expected.star ? 'star' : 'dot');
      const turn = Math.atan2(spark.y, spark.x) - expected.ang;
      expect(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)))).toBeLessThan(0.01);
      expect(Math.hypot(spark.x, spark.y) / expected.dist).toBeCloseTo(reach, 3);
      expect(spark.radius / expected.size).toBeCloseTo(expected.star ? starGrowth : dotGrowth, 2);
      expect(spark.delay).toBeCloseTo(expected.delay, 2);
      expect(spark.rotate).toBeCloseTo((expected.rot * 180) / Math.PI, 1);
      expect(spark.spin).toBeCloseTo((expected.spin * 180) / Math.PI, 1);
      expect(spark.colour).toBe(`rgb(${expected.col.map((channel) => Math.round(channel * 255)).join(' ')})`);
    });
  });

  it('keys every layer at the script\'s times and sizes', () => {
    const [, breathAmount, breathStart, breathPeak, breathEnd] = scriptMatch(/const gs = 1 \+ ([\d.]+) \* bump\(t, ([\d.]+), ([\d.]+), ([\d.]+)\)/).map(Number);
    expect(keyframes('brand-mark-breathe')).toContain(percent(breathStart));
    expect(keyframes('brand-mark-breathe')).toContain(`${percent(breathPeak)} {\n    transform: scale(${1 + breathAmount});`);
    expect(keyframes('brand-mark-breathe')).toContain(percent(breathEnd));
    expect(GLOBALS_CSS).toContain(`animation: brand-mark-breathe ${DURATION}s both;`);

    const [, starAmount, starStart, starPeak, , starEnd] = scriptMatch(/const ss = 1 \+ ([\d.]+) \* \(t <= [\d.]+ \? outBack\(seg\(t, ([\d.]+), ([\d.]+)\)\) : 1 - inOutCubic\(seg\(t, ([\d.]+), ([\d.]+)\)\)\)/).map(Number);
    expect(keyframes('brand-mark-star')).toContain(percent(starStart));
    expect(keyframes('brand-mark-star')).toContain(`${percent(starPeak)} {\n    transform: scale(${1 + starAmount});`);
    expect(keyframes('brand-mark-star')).toContain(percent(starEnd));
    // The star's own layer shows only while it is grown past the icon's star.
    expect(keyframes('brand-mark-star-shown')).toContain(`${percent(starStart)} {\n    opacity: 0;`);
    expect(keyframes('brand-mark-star-shown')).toContain(`${percent(starEnd)},\n  100% {\n    opacity: 0;`);

    const [, glowStart, glowPeak, glowEnd] = scriptMatch(/const glow = bump\(t, ([\d.]+), ([\d.]+), ([\d.]+)\)/).map(Number);
    for (const time of [glowStart, glowPeak, glowEnd]) expect(keyframes('brand-mark-glow')).toContain(percent(time));
    const glowStrength = Number(scriptMatch(/k = ([\d.]+) \* glow \*/)[1]);
    expect(GLOBALS_CSS).toContain(`rgb(255 158 115 / ${glowStrength}),`);

    const [, dotAmount, dotStart, dotPeak, dotEnd] = scriptMatch(/const rs = 1 \+ ([\d.]+) \* bump\(t, ([\d.]+), ([\d.]+), ([\d.]+)\)/).map(Number);
    expect(keyframes('brand-mark-dot')).toContain(percent(dotStart));
    expect(keyframes('brand-mark-dot')).toContain(`${percent(dotPeak)} {\n    transform: scale(${1 + dotAmount});`);
    expect(keyframes('brand-mark-dot')).toContain(percent(dotEnd));
    expect(keyframes('brand-mark-dot-shown')).toContain(`${percent(dotStart)} {\n    opacity: 0;`);
    expect(keyframes('brand-mark-dot-shown')).toContain(`${percent(dotEnd)},\n  100% {\n    opacity: 0;`);

    const [, sparkStart, sparkEnd] = scriptMatch(/const q = seg\(t, ([\d.]+) \+ s\.delay, ([\d.]+) \+ s\.delay\)/).map(Number);
    const flight = `${Number((sparkEnd - sparkStart).toFixed(2))}s`;
    expect(GLOBALS_CSS).toContain(`brand-mark-spark-reach ${flight} cubic-bezier(0.33, 1, 0.68, 1) calc(${sparkStart}s + var(--spark-delay)) both`);
    expect(GLOBALS_CSS).toContain(`brand-mark-spark-fade ${flight} calc(${sparkStart}s + var(--spark-delay)) both`);
    const [, fadeIn, fadeOut] = scriptMatch(/smooth\(0, ([\d.]+), q\) \* \(1 - smooth\(([\d.]+), 1, q\)\)/).map(Number);
    expect(keyframes('brand-mark-spark-fade')).toContain(`${Math.round(fadeIn * 100)}%,\n  ${Math.round(fadeOut * 100)}% {`);
    const shrink = Number(scriptMatch(/s\.size \* \(1 - ([\d.]+) \* q\)/)[1]);
    expect(keyframes('brand-mark-spark-turn')).toContain(`scale(${Number((1 - shrink).toFixed(2))})`);
  });

  it('places the star and the dot where the layer files have them', async () => {
    const star = await alphaCentre('magic-booklet-star.png');
    const dot = await alphaCentre('magic-booklet-dot.png');
    expect(Math.abs(star.x - STAR_CENTRE.x)).toBeLessThan(0.5);
    expect(Math.abs(star.y - STAR_CENTRE.y)).toBeLessThan(0.5);
    expect(Math.abs(dot.x - DOT_CENTRE.x)).toBeLessThan(0.5);
    expect(Math.abs(dot.y - DOT_CENTRE.y)).toBeLessThan(0.5);
  });
});

describe('brand mark', () => {
  it('is decorative, with every layer drawn from its file', () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector('.brand-mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.hasAttribute('data-still')).toBe(false);
    const images = [...container.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['', '', '']);
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      expect.stringContaining('magic-booklet-icon'),
      expect.stringContaining('magic-booklet-star'),
      expect.stringContaining('magic-booklet-dot'),
    ]);
    expect(container.querySelectorAll('.brand-mark-spark')).toHaveLength(16);
  });

  it('draws the icon alone when still', () => {
    const { container } = render(<BrandMark still />);
    expect(container.querySelector('.brand-mark')?.hasAttribute('data-still')).toBe(true);
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      expect.stringContaining('magic-booklet-icon'),
    ]);
    expect(container.querySelector('.brand-mark-glow')).toBeNull();
    expect(container.querySelectorAll('.brand-mark-spark')).toHaveLength(0);
  });

  it('rewinds a finished sting and leaves a playing one alone', () => {
    const finished = { playState: 'finished', currentTime: 1150, play: vi.fn() };
    replayBrandMark({ getAnimations: vi.fn(() => [finished]) } as unknown as HTMLElement);
    expect(finished.currentTime).toBe(0);
    expect(finished.play).toHaveBeenCalledTimes(1);

    const running = { playState: 'running', currentTime: 400, play: vi.fn() };
    const other = { playState: 'finished', currentTime: 770, play: vi.fn() };
    replayBrandMark({ getAnimations: vi.fn(() => [running, other]) } as unknown as HTMLElement);
    expect(running.currentTime).toBe(400);
    expect(other.play).not.toHaveBeenCalled();
  });

  it('keeps the still icon where the Web Animations API is missing', () => {
    expect(() => replayBrandMark({} as HTMLElement)).not.toThrow();
    expect(() => replayBrandMark(null)).not.toThrow();
  });
});
