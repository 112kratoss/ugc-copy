import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Code only: the comments that explain these choices quote the very styles
// the assertions forbid.
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Offscreen passes the iOS render server pays on every frame a feed scrolls
 * (docs/archive/home-scroll-hitches-2026-09-22.md). The Instruments hitch
 * reports named 11–13 of them per late frame; the Simulator's "Color
 * Off-screen Rendered" overlay showed where: each card's clipped corners, the
 * Create disc's masked box shadow, the dock, each avatar (expo-image clips
 * inside its own view, so rounding the photo instead of its container does not
 * help). These pin the ones removed without any visible change, so a later
 * edit cannot quietly bring them back.
 */
describe('feed render cost on iOS', () => {
  it('draws feed cards rounded without clipping them', () => {
    const shell = source('components/feed-card-shell.tsx');
    const container = shell.slice(shell.indexOf('<MotionView'), shell.indexOf('openMotion.animatedStyle'));
    expect(container).toContain('borderRadius: appTheme.radii.lg');
    expect(container).not.toMatch(/overflow:\s*'hidden'/);
  });

  it('gives the Create disc a path shadow instead of a masked box shadow', () => {
    const bar = source('components/magic-tab-bar.tsx');
    const disc = bar.slice(bar.indexOf('accessibilityLabel="Open create menu"'), bar.indexOf('<Plus size'));
    expect(disc).not.toContain('boxShadow');
    expect(disc).toContain('...CREATE_DISC_SHADOW');
    expect(bar).toMatch(/const CREATE_DISC_SHADOW = \{[^}]*shadowColor: '#000000'/);
    expect(bar).toContain('shadowRadius: 8,');
    // Fabric only computes a shadow path over an opaque background.
    expect(disc).toMatch(/backgroundColor: pressed \? PRIMARY_STRONG : PRIMARY/);
  });

  it('leaves the header rail\'s gradients to the render server', () => {
    // expo-linear-gradient paints on the main thread each time its view appears,
    // and the rail mounts a dozen slides on Home's first render and on every lane
    // switch: 17–20 ms of painting. React Native's own gradient is a CAGradientLayer.
    const home = source('components/home-dashboard.tsx');
    expect(home).not.toContain("from 'expo-linear-gradient'");
    expect(home).toContain("experimental_backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.04), rgba(0,0,0,0.72))'");
    expect(home).toContain("experimental_backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.04), rgba(0,0,0,0.48))'");
    const promo = home.slice(home.indexOf("if (slide.kind === 'promo')"), home.indexOf('const Icon = slide.id'));
    expect(promo).toContain('<View style={RAIL_PROMO_SCRIM} />');
    const preview = home.slice(home.indexOf('function ToolPreview'), home.indexOf('function FeedChips'));
    expect(preview).toContain('<View style={RAIL_PREVIEW_SCRIM} />');
  });
});

/**
 * Work that ran on the JS thread while a feed scrolled, with nothing on screen
 * to show for it. Both landed at the moments a scroll is most sensitive: the
 * dock re-rendered on the viewability change that elects the next video, and
 * the header rail turned every 4.6 s even after it had scrolled away.
 */
describe('work a scrolling Home feed does not pay for', () => {
  it('subscribes the dock to the sampled colour only where it paints it', () => {
    const bar = source('components/magic-tab-bar.tsx');
    expect(bar).toContain("useTabBarAmbientColor(surfaceMode === 'adaptive')");
    expect(bar).not.toContain('useTabBarAmbientColor()');
  });

  it('asks before each turn of the header rail', () => {
    const home = source('components/home-dashboard.tsx');
    const tick = home.slice(home.indexOf('const timer = setInterval'), home.indexOf('HOME_SLIDE_INTERVAL_MS);'));
    // The gate comes before any state or scroll the turn would cause.
    expect(tick.indexOf('if (!mayTurn()) return;')).toBeGreaterThan(-1);
    expect(tick.indexOf('if (!mayTurn()) return;')).toBeLessThan(tick.indexOf('setPageIndex'));
    expect(tick.indexOf('if (!mayTurn()) return;')).toBeLessThan(tick.indexOf('scrollToOffset'));
    expect(home).toContain('mayTurn={mayTurnSlides}');
    expect(home).toContain('feedMoving: playbackController.isMoving()');
    expect(home).toContain('onScroll={trackFeedOffset}');
  });
});
