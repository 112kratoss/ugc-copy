import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The module reads `Platform.OS` to decide whether anything downstream will
// spend the colour, and vitest cannot parse react-native's own entry point.
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));

import { contrastRatio } from '../lib/color-contrast';
import { themes } from '../lib/theme';
import {
  ADAPTIVE_INACTIVE_COLOR,
  ADAPTIVE_INACTIVE_LIGHT_COLOR,
  DEFAULT_LIGHT_TAB_BAR_COLOR,
  DEFAULT_TAB_BAR_COLOR,
  MAX_FILL_LUMINANCE,
  MIN_LIGHT_FILL_LUMINANCE,
  capFillLuminance,
  floorFillLuminance,
  getTabBarFillFromSource,
  getTabBarFillFromThumbhash,
  selectBottomVisibleAmbientSource,
} from '../lib/tab-bar-ambient';

/**
 * Real ThumbHashes, round-tripped through `rgbaToThumbHash` from flat 64x64
 * frames of the stated colour, then base64'd exactly as the media preview
 * pipeline stores them (`src/lib/media-preview-metadata.ts`). Baked in rather
 * than generated here so the mobile workspace does not take a dependency it
 * only ever uses under test — and so a change to the sampler is measured
 * against fixed inputs rather than against inputs that moved with it.
 */
const MEDIA = {
  /** #3c5a8c above, #965023 below. */
  coolTopWarmBottom: '1xcCXxB4eHd/h3iGh1iHmIiIhgiYiIAJ',
  /** The same two colours, swapped. */
  warmTopCoolBottom: 'lzgCXxB4d3dwiIiJeKiIaIiHifhoiI8G',
  forestGreen: 'TLgBBwCIeHiIeHhweIeHeId6iHQHd5gP',
  magenta: '3ScDBwA6WnZ5h3h4d4h4d4h2cH+HeKAF',
  neutralGrey: 'GwgCBwB7XId4iId4h3eIh4iHAAAAAAAA',
  nearBlackNight: 'xAcCBwCIaHd3eHd4eHh3h4hwB2mHAAAA',
  brightWhiteStudio: '+gcCBwB4eId4h4eHdwd4d4dwi19oAAAA',
} as const;

const FOREGROUNDS = ['#ff7a59', ADAPTIVE_INACTIVE_COLOR];

function channels(color: string) {
  return color.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16)) ?? [];
}

function chroma(color: string) {
  const rgb = channels(color);
  return Math.max(...rgb) - Math.min(...rgb);
}

/** Which channel dominates — the coarse question "is this bar warm or cool?". */
function dominantChannel(color: string) {
  const [red, green, blue] = channels(color);
  if (red >= green && red >= blue) return 'red';
  return green >= blue ? 'green' : 'blue';
}

describe('sampling the media nearest the dock', () => {
  it('reads the bottom of the preview, not its average', () => {
    // The only difference between these two fixtures is which half of the frame
    // holds which colour, so a whole-image mean cannot tell them apart. The bar
    // sits over the bottom of a card, so the bottom is what it has to report.
    const warmBelow = getTabBarFillFromThumbhash(MEDIA.coolTopWarmBottom);
    const coolBelow = getTabBarFillFromThumbhash(MEDIA.warmTopCoolBottom);

    expect(dominantChannel(warmBelow)).toBe('red');
    expect(dominantChannel(coolBelow)).toBe('blue');
  });

  it('keeps the hue the media actually has', () => {
    expect(dominantChannel(getTabBarFillFromThumbhash(MEDIA.forestGreen))).toBe('green');
    expect(dominantChannel(getTabBarFillFromThumbhash(MEDIA.magenta))).toBe('red');
    expect(chroma(getTabBarFillFromThumbhash(MEDIA.magenta))).toBeGreaterThan(20);
  });

  /**
   * The failure this replaced: HSL saturation divides chroma by `1 - |2L - 1|`,
   * so a rounding error becomes a strong hue as lightness approaches 0 or 1. A
   * flat near-black frame reported 0.20 "saturation" and a flat near-white frame
   * 0.14, both of them purple, from an actual chroma of 0.016. Working in
   * absolute chroma is what makes these three cases neutral.
   */
  it('reports grey media as grey, at either end of the range', () => {
    for (const neutral of [MEDIA.neutralGrey, MEDIA.nearBlackNight, MEDIA.brightWhiteStudio]) {
      expect(chroma(getTabBarFillFromThumbhash(neutral))).toBeLessThanOrEqual(4);
    }
  });

  it('tracks how bright the media is, within the dock range', () => {
    const night = channels(getTabBarFillFromThumbhash(MEDIA.nearBlackNight));
    const studio = channels(getTabBarFillFromThumbhash(MEDIA.brightWhiteStudio));

    expect(Math.max(...studio)).toBeGreaterThan(Math.max(...night));
  });

  it('falls back to the neutral dock rather than inventing a colour', () => {
    // A post with no media has no colour to report. Reaching for the card's
    // category accent instead is what painted the dock blue under warm media:
    // it meant "image post", not "this photo is blue".
    expect(getTabBarFillFromThumbhash(null)).toBe(DEFAULT_TAB_BAR_COLOR);
    expect(getTabBarFillFromThumbhash('')).toBe(DEFAULT_TAB_BAR_COLOR);
    expect(getTabBarFillFromSource(null)).toBe(DEFAULT_TAB_BAR_COLOR);
    expect(getTabBarFillFromSource({ thumbhash: null })).toBe(DEFAULT_TAB_BAR_COLOR);
  });

  it('survives metadata that is not a thumbhash at all', () => {
    for (const malformed of ['not a thumbhash', '****', 'AA', 'A', '=====']) {
      expect(getTabBarFillFromThumbhash(malformed)).toMatch(/^#[\da-f]{6}$/i);
    }
  });
});

/**
 * The guard that was missing while the dock painted itself from a category
 * palette: every one of those fills failed 4.5:1 for the coral active tab, at
 * 2.44:1 to 3.48:1, and `hig-type-and-contrast.test.ts` could not see it because
 * it only checks the static theme colours.
 *
 * This sweeps structurally-valid ThumbHash bytes rather than a handful of
 * fixtures, because the fill is computed from whatever media a creator uploads —
 * the property has to hold for inputs nobody chose.
 */
describe('the fill can never fail contrast', () => {
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function pseudoRandomThumbhash(seed: number) {
    // Deterministic LCG: a fixed sweep is reproducible when it fails, where
    // Math.random would report a different counterexample on every run.
    let state = seed * 1103515245 + 12345;
    let hash = '';
    for (let index = 0; index < 32; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      hash += BASE64[(state >> 16) & 63];
    }
    return hash;
  }

  it('clears 4.5:1 for both tab-label colours across the input space', () => {
    const failures: string[] = [];

    for (let seed = 0; seed < 4000; seed += 1) {
      const fill = getTabBarFillFromThumbhash(pseudoRandomThumbhash(seed));
      for (const foreground of FOREGROUNDS) {
        const ratio = contrastRatio(foreground, fill);
        if (ratio < 4.5) failures.push(`seed ${seed}: ${foreground} on ${fill} is ${ratio.toFixed(2)}:1`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('pulls an over-bright fill back to the ceiling instead of clipping it', () => {
    // Amber, the worst of the category fills it replaced: 2.44:1 for coral.
    const capped = capFillLuminance('#7c5a29');

    expect(capped).not.toBe('#7c5a29');
    expect(contrastRatio('#ff7a59', capped)).toBeGreaterThanOrEqual(4.5);
    // Darkened, not desaturated — the media's hue has to survive the cap.
    expect(dominantChannel(capped)).toBe('red');
    expect(chroma(capped)).toBeGreaterThan(10);
  });

  it('leaves a fill that already passes untouched', () => {
    expect(capFillLuminance(DEFAULT_TAB_BAR_COLOR)).toBe(DEFAULT_TAB_BAR_COLOR);
  });

  it('derives its ceiling from the coral active tint, which binds', () => {
    // The inactive label is far lighter and allows a much brighter dock; if the
    // ceiling ever tracks that one instead, the selected tab quietly fails.
    expect(MAX_FILL_LUMINANCE).toBeGreaterThan(0);
    expect(MAX_FILL_LUMINANCE).toBeLessThan(0.05);
  });
});

/**
 * The light scheme's dock runs the same guard from the other side: a pastel
 * of the media's hue near white, held above a luminance floor so the deep
 * coral active tab and the ink labels clear 4.5:1 whatever was uploaded.
 */
describe('the light dock', () => {
  const LIGHT_FOREGROUNDS = [themes.light.colors.primary, ADAPTIVE_INACTIVE_LIGHT_COLOR];
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function pseudoRandomThumbhash(seed: number) {
    let state = seed * 1103515245 + 12345;
    let hash = '';
    for (let index = 0; index < 32; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      hash += BASE64[(state >> 16) & 63];
    }
    return hash;
  }

  it('clears 4.5:1 for both light tab-label colours across the input space', () => {
    const failures: string[] = [];
    for (let seed = 0; seed < 4000; seed += 1) {
      const fill = getTabBarFillFromThumbhash(pseudoRandomThumbhash(seed), 'light');
      for (const foreground of LIGHT_FOREGROUNDS) {
        const ratio = contrastRatio(foreground, fill);
        if (ratio < 4.5) failures.push(`seed ${seed}: ${foreground} on ${fill} is ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the media\'s hue, as a pastel', () => {
    expect(dominantChannel(getTabBarFillFromThumbhash(MEDIA.forestGreen, 'light'))).toBe('green');
    expect(dominantChannel(getTabBarFillFromThumbhash(MEDIA.magenta, 'light'))).toBe('red');
    const magenta = getTabBarFillFromThumbhash(MEDIA.magenta, 'light');
    expect(chroma(magenta)).toBeGreaterThan(6);
    // Light, not a slab: every channel stays near white.
    expect(Math.min(...channels(magenta))).toBeGreaterThan(200);
  });

  it('falls back to neutral paper with no media, and leaves the dark dock alone', () => {
    expect(getTabBarFillFromThumbhash(null, 'light')).toBe(DEFAULT_LIGHT_TAB_BAR_COLOR);
    expect(getTabBarFillFromSource({ thumbhash: null }, 'light')).toBe(DEFAULT_LIGHT_TAB_BAR_COLOR);
    expect(getTabBarFillFromThumbhash(MEDIA.magenta)).toBe(getTabBarFillFromThumbhash(MEDIA.magenta, 'dark'));
    expect(getTabBarFillFromThumbhash(MEDIA.magenta, 'light')).not.toBe(getTabBarFillFromThumbhash(MEDIA.magenta, 'dark'));
  });

  it('lifts a fill that is too dark for ink instead of clipping it', () => {
    const lifted = floorFillLuminance('#d9a0a0');
    expect(contrastRatio(themes.light.colors.primary, lifted)).toBeGreaterThanOrEqual(4.5);
    expect(dominantChannel(lifted)).toBe('red');
    expect(floorFillLuminance(DEFAULT_LIGHT_TAB_BAR_COLOR)).toBe(DEFAULT_LIGHT_TAB_BAR_COLOR);
  });

  it('derives its floor from the deep coral active tint, which binds', () => {
    expect(MIN_LIGHT_FILL_LUMINANCE).toBeGreaterThan(0.6);
    expect(MIN_LIGHT_FILL_LUMINANCE).toBeLessThan(0.8);
  });
});

describe('choosing which visible card to read', () => {
  it('uses the bottommost visible card near the dock', () => {
    expect(selectBottomVisibleAmbientSource([
      { index: 3, isViewable: true, item: { previewThumbhash: 'top-hash' } },
      { index: 4, isViewable: false, item: { previewThumbhash: 'hidden-hash' } },
      { index: 5, isViewable: true, item: { previewThumbhash: 'bottom-hash' } },
      { index: 6, isViewable: true, item: { previewThumbhash: null } },
    ])).toEqual({ thumbhash: 'bottom-hash' });
  });

  it('reports nothing when no visible card carries media', () => {
    expect(selectBottomVisibleAmbientSource([
      { index: 0, isViewable: true, item: { previewThumbhash: null } },
      { index: 1, isViewable: false, item: { previewThumbhash: 'hidden' } },
    ])).toBeNull();
    expect(selectBottomVisibleAmbientSource([])).toBeNull();
  });
});

/**
 * The colour exists to tint a translucent iOS dock. Android's is an opaque
 * panel that never adapts, and the tab bar subscribes to this store, so leaving
 * the wiring live there re-rendered the whole bar on every viewability change
 * to arrive at a value it throws away.
 *
 * The platform flag is read when the module loads, so each case re-imports it.
 */
describe('adapting only where a surface spends the colour', () => {
  afterEach(() => {
    platform.os = 'ios';
  });

  async function mountColourProbe(os: 'ios' | 'android', spends = true, scheme: 'dark' | 'light' = 'dark') {
    platform.os = os;
    vi.resetModules();
    const module = await import('../lib/tab-bar-ambient');
    const painted: string[] = [];
    function Probe() {
      painted.push(module.useTabBarAmbientColor(spends, scheme));
      return null;
    }

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(React.createElement(Probe));
    });

    return { module, painted, unmount: () => renderer.act(() => tree.unmount()) };
  }

  /**
   * Reading any property of a token means the sampler ran. A handler that stops
   * at the door never touches them, which is the difference this asserts —
   * "the colour did not change" alone cannot tell a short-circuit apart from a
   * bar that simply is not listening.
   */
  const EXPLODING_FEED = [{
    index: 0,
    get isViewable(): boolean {
      throw new Error('sampled a feed nothing will read');
    },
    item: { previewThumbhash: MEDIA.magenta },
  }] as never;

  it('repaints the iOS dock when a feed reports media', async () => {
    const { module, painted, unmount } = await mountColourProbe('ios');
    expect(painted).toEqual([DEFAULT_TAB_BAR_COLOR]);

    renderer.act(() => {
      module.setTabBarAmbientSource({ thumbhash: MEDIA.magenta });
    });

    expect(painted).toHaveLength(2);
    expect(painted[1]).not.toBe(DEFAULT_TAB_BAR_COLOR);
    unmount();
  });

  it('paints the light dock from the same card, already computed for the light scheme', async () => {
    const { module, painted, unmount } = await mountColourProbe('ios', true, 'light');
    expect(painted).toEqual([DEFAULT_LIGHT_TAB_BAR_COLOR]);

    renderer.act(() => {
      module.setTabBarAmbientSource({ thumbhash: MEDIA.magenta });
    });

    expect(painted).toEqual([DEFAULT_LIGHT_TAB_BAR_COLOR, module.getTabBarFillFromThumbhash(MEDIA.magenta, 'light')]);
    unmount();
  });

  it('leaves the Android dock neutral without re-rendering the bar', async () => {
    const { module, painted, unmount } = await mountColourProbe('android');
    expect(painted).toEqual([DEFAULT_TAB_BAR_COLOR]);

    renderer.act(() => {
      module.setTabBarAmbientSource({ thumbhash: MEDIA.magenta });
    });

    expect(painted).toEqual([DEFAULT_TAB_BAR_COLOR]);
    unmount();
  });

  /**
   * Liquid Glass tints itself from its backdrop and the Reduce Transparency bar
   * is a fixed solid, so on iOS 26 the bar reads no fill at all. Subscribed
   * anyway, it re-rendered on each card the feed brought under the dock — the
   * viewability change that also elects the next video.
   */
  it('leaves an iOS bar that paints no fill unsubscribed', async () => {
    const { module, painted, unmount } = await mountColourProbe('ios', false);
    expect(painted).toEqual([DEFAULT_TAB_BAR_COLOR]);

    renderer.act(() => {
      module.setTabBarAmbientSource({ thumbhash: MEDIA.magenta });
    });

    expect(painted).toEqual([DEFAULT_TAB_BAR_COLOR]);
    unmount();
  });

  it('samples a scrolling feed on iOS and not on Android', async () => {
    async function handlerFor(os: 'ios' | 'android') {
      platform.os = os;
      vi.resetModules();
      const module = await import('../lib/tab-bar-ambient');
      let report!: (info: { viewableItems: never }) => void;
      function Probe() {
        report = module.useTabBarAmbientFeed(true) as typeof report;
        return null;
      }
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(React.createElement(Probe));
      });
      return { report, unmount: () => renderer.act(() => tree.unmount()) };
    }

    const ios = await handlerFor('ios');
    expect(() => ios.report({ viewableItems: EXPLODING_FEED })).toThrow('sampled a feed');
    ios.unmount();

    const android = await handlerFor('android');
    expect(() => android.report({ viewableItems: EXPLODING_FEED })).not.toThrow();
    android.unmount();
  });
});
