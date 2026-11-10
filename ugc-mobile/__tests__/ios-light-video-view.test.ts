import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEED_VIDEO_VIEW_PROPS } from '../lib/feed-video-view-props';

const projectRoot = join(__dirname, '..');
const shippedPatch = 'patches/expo-video+55.0.21+004+ios-light-video-view.patch';

/**
 * The iOS light video host (docs/archive/home-scroll-hitches-2026-09-22.md,
 * Layer 2), shipped from store build 0.1.6. Until then it lived in
 * `experiments/ios-light-video-view/`: `@expo/fingerprint` hashes `patches/`,
 * so a Swift file there strands every JavaScript-only update to the binaries
 * already out. On the iPhone 16e it took `AVPlayerViewController` off the main
 * thread entirely (22–29 ms per 40 s of scrolling and a reel open) and made
 * React Native's clip walk about 11% cheaper (see that folder's README).
 */
describe('iOS light video host', () => {
  const patch = readFileSync(join(projectRoot, shippedPatch), 'utf8');
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');

  it('ships after the three it was written on, and no later patch touches iOS', () => {
    // patch-package applies a package's numbered patches in order, and this one
    // was cut from a tree that already carried 001-003. The Android patches that
    // graduated for 0.1.9 (005-007) come after it and change Kotlin only, so the
    // iOS files stay as this patch leaves them.
    const shipped = readdirSync(join(projectRoot, 'patches')).filter((name) => name.startsWith('expo-video+')).sort();
    const own = shipped.indexOf('expo-video+55.0.21+004+ios-light-video-view.patch');
    expect(shipped.slice(0, own)).toEqual([
      'expo-video+55.0.21+001+ios-range-cache.patch',
      'expo-video+55.0.21+002+android-light-player-view.patch',
      'expo-video+55.0.21+003+ios-cache-ownership.patch',
    ]);
    for (const later of shipped.slice(own + 1)) {
      const changed = readFileSync(join(projectRoot, 'patches', later), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('+++ b/'));
      expect(changed.length, later).toBeGreaterThan(0);
      for (const file of changed) {
        expect(file, later).toContain('/expo-video/android/');
      }
    }
    expect(shipped.filter((name) => readFileSync(join(projectRoot, 'patches', name), 'utf8').includes('LightVideoView'))).toEqual([
      'expo-video+55.0.21+004+ios-light-video-view.patch',
    ]);
  });

  it('draws through an AVPlayerLayer instead of an AVPlayerViewController', () => {
    expect(added).toContain('override static var layerClass: AnyClass { AVPlayerLayer.self }');
    expect(added).not.toContain('AVPlayerViewController(');
    // The poster lifts on the same signal the stock view reads from the controller.
    expect(added).toContain('surface.playerLayer.observe(\\.isReadyForDisplay');
  });

  it('is registered with the props the feed passes and pauses with the app', () => {
    expect(added).toContain('Constant("supportsLightweightViews") { true }');
    expect(added).toContain('View(LightVideoView.self) {');
    for (const prop of ['player', 'contentFit', 'contentPosition']) {
      expect(added).toContain(`Prop("${prop}")`);
    }
    expect(added).toContain('Events("onFirstFrameRender")');
    expect(added).toContain('for lightVideoView in lightVideoViews.allObjects {');
  });

  it('is chosen only for controls-off views on binaries that advertise it', () => {
    expect(added).toContain('Platform.OS === "ios" && NativeVideoModule.supportsLightweightViews');
    expect(added).toContain("const LightView = NativeLightVideoViewIOS ?? (this.props.surfaceType === 'textureView'");
    expect(FEED_VIDEO_VIEW_PROPS.nativeControls).toBe(false);
  });
});

describe('feed video view props', () => {
  it('never runs Live Text analysis on paused feed frames', () => {
    // AVKit: "If the value is true, a player view controller tries to find
    // objects, text, and people when you pause media playback." Every prepared
    // feed video is paused, and none of these views take touches.
    expect(FEED_VIDEO_VIEW_PROPS.allowsVideoFrameAnalysis).toBe(false);
  });
});
