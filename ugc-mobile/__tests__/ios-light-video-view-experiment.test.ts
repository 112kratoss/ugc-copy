import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEED_VIDEO_VIEW_PROPS } from '../lib/feed-video-view-props';

const projectRoot = join(__dirname, '..');
const experimentPatch = 'experiments/ios-light-video-view/patches/expo-video+55.0.21.patch';

/**
 * The iOS light video host (docs/archive/home-scroll-hitches-2026-09-22.md,
 * Layer 2). It is native, so it lives outside `patches/` until a store build
 * carries it: `@expo/fingerprint` hashes `patches/`, and a Swift file there
 * would strand every JavaScript-only update. Promotion moves the file to
 * `patches/expo-video+55.0.21+004+ios-light-video-view.patch` and updates the
 * first assertion here in the same store-build commit.
 */
describe('iOS light video host experiment', () => {
  const patch = readFileSync(join(projectRoot, experimentPatch), 'utf8');
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');

  it('stays out of the shipped patches until a store build carries it', () => {
    const shipped = readdirSync(join(projectRoot, 'patches'))
      .filter((name) => name.startsWith('expo-video+'))
      .map((name) => readFileSync(join(projectRoot, 'patches', name), 'utf8'));
    expect(shipped.some((text) => text.includes('LightVideoView'))).toBe(false);
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
