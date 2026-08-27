import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isShowcaseCoverVideoStreaming } from '../lib/showcase-display';
import { mergeAspectRatios, partitionAspectRatioUpdates } from '../lib/showcase-feed-view-model';
import { SHOWCASE_ONSCREEN_VIEWABILITY } from '../lib/showcase-feed-events';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '../lib/types';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

const files = ['app', 'components', 'lib']
  .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
  .map((absolutePath) => ({
    name: path.relative(mobileRoot, absolutePath).replaceAll(path.sep, '/'),
    source: readFileSync(absolutePath, 'utf8'),
  }));

function file(name: string) {
  const match = files.find((entry) => entry.name === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match.source;
}

/**
 * S5's rules, in the form a suite can hold. Sources: Collections, Image views,
 * Playing video — plus the Gestures sentence about an app that looks frozen.
 */

function media(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.example.com/original.mp4',
    previewUrl: 'https://cdn.example.com/poster.jpg',
    previewThumbhash: null,
    previewCacheKey: 'preview-key',
    gridReady: true,
    mediaKind: 'video',
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
    ...overrides,
  } as ShowcaseMediaItem;
}

function feedItem(mediaItems: ShowcaseMediaItem[]): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: mediaItems[0]?.url ?? null,
    mediaKind: mediaItems[0]?.mediaKind ?? null,
    mediaItems,
  } as unknown as ShowcaseFeedItem;
}

/**
 * Collections, iOS: "Use caution when making dynamic layout changes … If
 * possible, try to avoid changing the layout while people are viewing and
 * interacting with it, unless it's in response to an explicit action."
 */
describe('HIG collections — the grid does not resize under the reader', () => {
  it('applies a measured ratio to a card that is off screen', () => {
    const { apply, hold } = partitionAspectRatioUpdates({ a: 1.5 }, new Set(['b']));

    expect(apply).toEqual({ a: 1.5 });
    expect(hold).toEqual({});
  });

  it('holds a measured ratio for a card the reader is looking at', () => {
    const { apply, hold } = partitionAspectRatioUpdates({ a: 1.5, b: 0.8 }, new Set(['b']));

    expect(apply).toEqual({ a: 1.5 });
    expect(hold).toEqual({ b: 0.8 });
  });

  it('releases a held ratio once its card has left the screen', () => {
    const held = partitionAspectRatioUpdates({ b: 0.8 }, new Set(['b'])).hold;

    expect(partitionAspectRatioUpdates(held, new Set()).apply).toEqual({ b: 0.8 });
  });

  it('keeps the same map object when nothing actually changed, so no cell re-renders', () => {
    const current = { a: 1.5 };

    expect(mergeAspectRatios(current, { a: 1.5 })).toBe(current);
    expect(mergeAspectRatios(current, { a: 0.8 })).toEqual({ a: 0.8 });
  });

  it('asks viewability for any pixel on screen, not for the autoplay threshold', () => {
    // A card scrolled almost out of the top still shifts everything beneath it.
    expect(SHOWCASE_ONSCREEN_VIEWABILITY.itemVisiblePercentThreshold).toBe(1);
    expect(SHOWCASE_ONSCREEN_VIEWABILITY.minimumViewTime).toBe(0);
  });

  it('routes every resolved ratio through the partition, never straight into state', () => {
    const screen = file('app/(tabs)/showcase.tsx');

    expect(screen).toContain('viewabilityConfig: SHOWCASE_ONSCREEN_VIEWABILITY');
    expect(screen).toContain('partitionAspectRatioUpdates(');
    // Two writers only: the flush partition and the release. A third would be a
    // measurement landing on a card that is being looked at.
    const writes = screen.match(/setResolvedAspectRatios\([\s\S]*?\);/g) ?? [];
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toBe('setResolvedAspectRatios((current) => mergeAspectRatios(current, apply));');
    }
  });
});

/**
 * Playing video: a custom player must "reference the behavior and interface of
 * the system video player", because "a custom experience that diverges slightly
 * from the system-provided experience can cause frustration". A play control
 * drawn over a video that is already playing is that divergence.
 */
describe('HIG playing video — the play badge marks a poster, not a playing tile', () => {
  it('keeps the badge while the tile is not elected', () => {
    expect(isShowcaseCoverVideoStreaming(feedItem([media()]), false)).toBe(false);
  });

  it('keeps the badge for a poster-only item, however it was elected', () => {
    // The server's explicit null means "no feed stream" — the tile shows its
    // poster forever, so the badge is still telling the truth.
    expect(isShowcaseCoverVideoStreaming(feedItem([media({ feedStreamUrl: null })]), true)).toBe(false);
  });

  it('keeps the badge when the cover is an image', () => {
    expect(isShowcaseCoverVideoStreaming(feedItem([media({ mediaKind: 'image' })]), true)).toBe(false);
  });

  it('drops the badge once the cover is actually streaming', () => {
    const streaming = media({ feedStreamUrl: 'https://cdn.example.com/teaser.mp4' });

    expect(isShowcaseCoverVideoStreaming(feedItem([streaming]), true)).toBe(true);
  });

  it('gates the rendered badge on that answer, with Reduce Motion folded in', () => {
    const screen = file('app/(tabs)/showcase.tsx');

    expect(screen).toContain('{isVideoCard && !coverVideoStreaming ? <VideoCornerPlay /> : null}');
    expect(screen).toContain('isShowcaseCoverVideoStreaming(card.item, showActiveVideo && !reducedMotion)');
  });
});

/**
 * Gestures: "if you don't clearly communicate why a gesture doesn't work,
 * people might think your app has frozen." The feed suspends its own scrolling
 * while a card's media is swiped sideways, so that lock has to be released by
 * everything that can take it — including a cell that is torn down mid-drag.
 */
describe('HIG gestures — the feed cannot be left unable to scroll', () => {
  it('deduplicates each carousel\'s drag transitions and releases on unmount', () => {
    const carousel = file('components/showcase-media-preview.tsx');

    expect(carousel).toContain('function useCarouselDragReporter(');
    // One drag reports `false` twice — at drag end and again when momentum
    // expires — so the count is only sound if transitions are deduplicated.
    expect(carousel).toContain('if (draggingRef.current === dragging) return;');
    expect(carousel).toContain('useEffect(() => () => report(false), [report]);');
    // No raw handler may bypass the reporter.
    expect(carousel).not.toMatch(/onScroll(BeginDrag|EndDrag)=\{\(\) => onScrollToggle\?\.\(/);
  });

  it('counts the carousels holding the lock instead of trusting the last report', () => {
    const screen = file('app/(tabs)/showcase.tsx');

    expect(screen).toContain('mediaDragCountRef.current = Math.max(0, mediaDragCountRef.current + (scrolling ? 1 : -1));');
    expect(screen).toContain('setIsSwipingMedia(mediaDragCountRef.current > 0);');
    expect(screen).toContain('onScrollToggle={handleMediaScrollToggle}');
    // The screen's only other writes are the mount default and the reset that
    // runs when every carousel is about to unmount.
    expect(screen.match(/setIsSwipingMedia\(/g)).toHaveLength(2);
  });
});

/**
 * Motion: "Make motion optional." One store answers the preference for the
 * whole process; a private copy in a component that the feed mounts per card
 * opens a native listener per card and starts every one of them at `false`.
 */
describe('HIG motion — the Reduce Motion preference is read in exactly one place', () => {
  it('leaves the reduce-motion listener to lib/motion', () => {
    const owners = files
      .filter((entry) => /reduceMotionChanged|isReduceMotionEnabled/.test(entry.source))
      .map((entry) => entry.name);

    expect(owners).toEqual(['lib/motion.ts']);
  });

  it('has the feed grid and the drawer reach for the shared hook', () => {
    for (const name of ['components/showcase-media-preview.tsx', 'components/home-side-menu.tsx']) {
      expect(file(name)).toContain("import { useReducedMotion } from '@/lib/motion';");
    }
  });
});

/**
 * Image views: "Compositing text on top of images can decrease both the clarity
 * of the image and the legibility of the text … ensure the text contrasts well
 * with the image, and consider ways to make the text object stand out, like
 * adding a text shadow or background layer."
 *
 * Every mark the feed draws over media sits on such a layer. The layer is
 * translucent, so the number that matters is the one over the brightest media
 * the layer can be asked to cover: pure white.
 */
describe('HIG image views — overlay marks stay legible over the brightest media', () => {
  const WHITE: Rgb = [255, 255, 255];

  it('clears 4.5:1 for every accent the pin badge can print', () => {
    const chip = composite([5, 5, 7], 0.78, WHITE);
    // lib/theme's tool accents, which are what `PinBadge` colours its label.
    const accents = ['#73bff2', '#ff8e72', '#b7a0f5', '#67d6a7', '#f2b95e'];

    for (const accent of accents) {
      expect(contrast(hexToRgb(accent), chip)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('clears 4.5:1 for the carousel page counter', () => {
    expect(contrast(WHITE, composite([3, 3, 6], 0.68, WHITE))).toBeGreaterThanOrEqual(4.5);
  });

  it('clears the 3:1 graphical floor for the corner play badge', () => {
    expect(contrast(WHITE, composite([0, 0, 0], 0.42, WHITE))).toBeGreaterThanOrEqual(3);
  });

  it('draws the pin badge on the type ramp rather than an override', () => {
    const screen = file('app/(tabs)/showcase.tsx');
    const badge = screen.slice(screen.indexOf('function PinBadge('));

    // A line box the size of the glyphs clips descenders on Android; the ramp
    // already publishes one, and padding is what sets the pill's height.
    expect(badge).toContain('...appTheme.type.caption');
    expect(badge.slice(0, badge.indexOf('function VideoCornerPlay('))).not.toContain('lineHeight:');
  });
});

type Rgb = [number, number, number];

function hexToRgb(value: string): Rgb {
  const hex = value.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

/** What a translucent overlay colour actually becomes over a given backdrop. */
function composite(overlay: Rgb, alpha: number, backdrop: Rgb): Rgb {
  return overlay.map((channel, index) => alpha * channel + (1 - alpha) * backdrop[index]) as Rgb;
}

function relativeLuminance([red, green, blue]: Rgb) {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left: Rgb, right: Rgb) {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
