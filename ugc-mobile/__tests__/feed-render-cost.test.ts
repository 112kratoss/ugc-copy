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
  it('separates feed rows without clipping or shadowing them', () => {
    const shell = source('components/feed-card-shell.tsx');
    const container = shell.slice(shell.indexOf('<MotionView'), shell.indexOf('openMotion.animatedStyle'));
    expect(container).toContain('borderBottomWidth: StyleSheet.hairlineWidth');
    expect(container).not.toContain('borderRadius');
    expect(container).not.toContain('boxShadow');
    expect(container).not.toMatch(/overflow:\s*'hidden'/);
  });

  it('gives the Create disc a path shadow instead of a masked box shadow', () => {
    const bar = source('components/magic-tab-bar.tsx');
    const disc = bar.slice(bar.indexOf('accessibilityLabel={createControlLabel(runningGenerations)}'), bar.indexOf('<Plus size'));
    expect(disc).not.toContain('boxShadow');
    expect(disc).toContain('...CREATE_DISC_SHADOW_SHAPE');
    expect(disc).toContain('shadowColor: theme.tabBar.discShadowColor');
    expect(bar).toContain('shadowRadius: 8,');
    // Fabric only computes a shadow path over an opaque background: the coral
    // fill is solid in both schemes.
    expect(disc).toMatch(/backgroundColor: pressed \? theme\.colors\.primaryFillPressed : theme\.colors\.primaryFill/);
  });

  it('leaves the shelf\'s caption shade to the render server', () => {
    // expo-linear-gradient paints on the main thread each time its view appears,
    // and the shelf mounts every card on Home's first render: the header rail it
    // replaced cost 17–20 ms of painting that way. React Native's own gradient
    // is a CAGradientLayer.
    const shelf = source('components/home-shelf.tsx');
    const home = source('components/home-dashboard.tsx');
    for (const file of [shelf, home]) expect(file).not.toContain("from 'expo-linear-gradient'");
    // Shades over pictures, so the media ground in both schemes.
    expect(shelf).toMatch(
      /const CAPTION_SHADE: ViewStyle = \{\s*position: 'absolute',\s*inset: 0,\s*experimental_backgroundImage: linearGradient\('to bottom', \[\s*\{ color: hexWithAlpha\(mediaColors\.mediaGround, 0\.04\), at: 0 \},/,
    );
    const card = shelf.slice(shelf.indexOf('function CreationCard('), shelf.indexOf('function ActionCard('));
    expect(card).toContain('<View style={CAPTION_SHADE} />');
  });

  it('leaves the reel\'s shades to the render server', () => {
    // A reel opening mounts the slide's caption shade, which then grows to the
    // caption, its neighbours' shades and the top shade. expo-linear-gradient
    // painted every one of them on the main thread. The letterbox bands have
    // been plain black since 2026-09-25, with no shade at all.
    const chrome = source('components/reel-chrome.tsx');
    const bands = source('components/letterbox-bands.tsx');
    for (const file of [chrome, bands]) expect(file).not.toContain("from 'expo-linear-gradient'");
    expect(chrome).toContain("const CAPTION_SCRIM = 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.42) 42%, rgba(0,0,0,0.84) 100%)'");
    expect(chrome).toContain('experimental_backgroundImage: CAPTION_SCRIM');
    expect(bands).toContain('backgroundColor: mediaColors.mediaGround');
    expect(bands).not.toContain('experimental_backgroundImage');
    const scrim = source('components/top-scrim.tsx');
    const branch = scrim.indexOf("if (over === 'media')");
    const media = scrim.slice(branch, scrim.indexOf('\n  }\n', branch));
    expect(media).toContain('experimental_backgroundImage: shade');
    expect(media).not.toContain('<LinearGradient');
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
    expect(bar).toContain("useTabBarAmbientColor(surfaceMode === 'adaptive', theme.scheme)");
    expect(bar).not.toContain('useTabBarAmbientColor()');
  });

  it('runs no timer on Home: the shelf moves only when the person moves it', () => {
    // The rail it replaced turned every 4.6 s, gated on the feed being at rest
    // and the rail on screen. The shelf holds still, so there is no turn to gate.
    const home = source('components/home-dashboard.tsx');
    const shelf = source('components/home-shelf.tsx');
    expect(home).not.toContain('HOME_SLIDE_INTERVAL_MS');
    expect(shelf).not.toContain('setInterval');
  });
});
