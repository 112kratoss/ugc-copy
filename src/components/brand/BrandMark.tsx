import type { CSSProperties, Ref } from 'react';

import brandIcon from './magic-booklet-icon.png';
import brandDot from './magic-booklet-dot.png';
import brandStar from './magic-booklet-star.png';

/**
 * The app icon as the web shell's brand mark, with the app's launch sting played over it
 * (ugc-mobile/scripts/make-splash-sting.mjs, which makes the clip the app opens on): the
 * icon breathes, its star pops with a warm glow and throws a burst of sparkles, the dot
 * pulses, and everything settles back to the still icon in 1.15 s. The timings and curves
 * are the script's, as `.brand-mark` keyframes in globals.css, so the sting plays from the
 * first paint of a page load, before any script runs. Transforms and opacity only, so the
 * browser composites every frame; nothing under reduced motion. The layers are made by
 * scripts/build/make-brand-mark-layers.mjs, which prints the two centres below.
 */

/** Tile size in px; the sparkles' reach is set in px against it. */
export const BRAND_MARK_SIZE = 40;
/** Where the star and the dot sit, as percentages of the tile. */
const STAR_CENTRE = { x: 72.67, y: 29.36 };
const DOT_CENTRE = { x: 82.51, y: 18.72 };
/** The script's gaussian glow (sigma 85 of its 640 px canvas), as a share of the tile. */
const GLOW_SIGMA = (85 / 640) * 100;

// The script draws on a 640 px canvas that is the whole tile. Its sparkles are a pixel or
// less across at 40 px, so they are drawn larger here and thrown a little further, to read
// at the size the sidebar shows them.
const CANVAS_TO_TILE = BRAND_MARK_SIZE / 640;
const REACH = 1.4;
const STAR_SPARK_GROWTH = 2.6;
const DOT_SPARK_GROWTH = 4;
const SPARK_COLOURS = ['rgb(255 138 102)', 'rgb(255 196 110)', 'rgb(199 156 242)', 'rgb(255 138 102)'] as const;

export type BrandMarkSpark = {
  shape: 'star' | 'dot';
  /** Where it ends, in px from the star's centre. */
  x: number;
  y: number;
  /** Its radius at the start, in px. */
  radius: number;
  /** Seconds after the burst starts. */
  delay: number;
  /** Its turn at the start, and how far it turns over its flight, in degrees. */
  rotate: number;
  spin: number;
  colour: string;
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
const degrees = (radians: number) => round((radians * 180) / Math.PI);

/** The script's 16 sparkles, from its seed and in its order of draws, in the tile's px. */
export function brandMarkSparks(): BrandMarkSpark[] {
  const rand = mulberry32(1101);
  return Array.from({ length: 16 }, (_, k) => {
    const star = k < 9;
    const angle = -Math.PI / 2 + (k / 16) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const delay = rand() * 0.06;
    const dist = star ? 115 + rand() * 95 : 70 + rand() * 80;
    const size = star ? 13 + rand() * 8 : 2.8 + rand() * 1.8;
    const spin = (rand() - 0.5) * 5;
    const rotate = rand() * Math.PI * 2;
    const reach = dist * CANVAS_TO_TILE * REACH;
    return {
      shape: star ? 'star' : 'dot',
      x: round(Math.cos(angle) * reach),
      y: round(Math.sin(angle) * reach),
      radius: round(size * CANVAS_TO_TILE * (star ? STAR_SPARK_GROWTH : DOT_SPARK_GROWTH)),
      delay: round(delay),
      rotate: degrees(rotate),
      spin: degrees(spin),
      colour: SPARK_COLOURS[k % SPARK_COLOURS.length],
    };
  });
}

const SPARKS = brandMarkSparks();

/**
 * Plays the sting again, from the start, unless it is playing now. Its animations keep
 * their last frame (`animation-fill-mode: both`), the still icon, so they stay listed by
 * getAnimations() after the first play and can be rewound; under reduced motion there are
 * none, and a browser without the Web Animations API keeps the still icon.
 */
export function replayBrandMark(mark: HTMLElement | null) {
  if (!mark || typeof mark.getAnimations !== 'function') return;
  const animations = mark.getAnimations({ subtree: true });
  if (animations.some((animation) => animation.playState === 'running')) return;
  for (const animation of animations) {
    animation.currentTime = 0;
    animation.play();
  }
}

export default function BrandMark({ ref }: { ref?: Ref<HTMLSpanElement> }) {
  const glowSize = GLOW_SIGMA * 6;
  return (
    <span ref={ref} aria-hidden className="brand-mark">
      <span className="brand-mark-tile">
        {/* Plain images: fixed files sized for the tile, never sent through the image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brandIcon.src} width={BRAND_MARK_SIZE} height={BRAND_MARK_SIZE} alt="" decoding="async" className="brand-mark-layer" />
        <span
          className="brand-mark-glow"
          style={{
            left: `${round(STAR_CENTRE.x - glowSize / 2)}%`,
            top: `${round(STAR_CENTRE.y - glowSize / 2)}%`,
            width: `${round(glowSize)}%`,
            height: `${round(glowSize)}%`,
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={brandStar.src}
          width={BRAND_MARK_SIZE}
          height={BRAND_MARK_SIZE}
          alt=""
          decoding="async"
          className="brand-mark-layer brand-mark-star"
          style={{ transformOrigin: `${STAR_CENTRE.x}% ${STAR_CENTRE.y}%` }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={brandDot.src}
          width={BRAND_MARK_SIZE}
          height={BRAND_MARK_SIZE}
          alt=""
          decoding="async"
          className="brand-mark-layer brand-mark-dot"
          style={{ transformOrigin: `${DOT_CENTRE.x}% ${DOT_CENTRE.y}%` }}
        />
      </span>
      <span className="brand-mark-burst" style={{ left: `${STAR_CENTRE.x}%`, top: `${STAR_CENTRE.y}%` }}>
        {SPARKS.map((spark, index) => (
          <span
            key={index}
            className="brand-mark-spark"
            style={{ '--spark-x': `${spark.x}px`, '--spark-y': `${spark.y}px`, '--spark-delay': `${spark.delay}s` } as CSSProperties}
          >
            <span
              className={spark.shape === 'star' ? 'brand-mark-spark-star' : 'brand-mark-spark-dot'}
              style={
                {
                  width: round(spark.radius * 2),
                  height: round(spark.radius * 2),
                  marginLeft: -spark.radius,
                  marginTop: -spark.radius,
                  background: spark.colour,
                  '--spark-rotate': `${spark.rotate}deg`,
                  '--spark-spin': `${spark.spin}deg`,
                } as CSSProperties
              }
            />
          </span>
        ))}
      </span>
    </span>
  );
}
