import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LAYOUT_DIR, LAYOUT_FILES, writeLightPlayerViewLayouts } from '../plugins/withAndroidLightPlayerView';

const projectRoot = join(__dirname, '..');
const layout = (file: string) => readFileSync(join(LAYOUT_DIR, file), 'utf8');

/**
 * The light Media3 PlayerView for expo-video's Android video views. Measured
 * on the S24 (2026-09-19): the stock layout inflates 38 descendants per player,
 * 5–23 ms on the UI thread at every open, hand-back and feed activation.
 */
describe('the light Android PlayerView layouts', () => {
  it('override expo-video\'s two layouts by name, keeping their root ids and surface types', () => {
    const texture = layout('texture_player_view.xml');
    expect(texture).toContain('android:id="@+id/texture_player_view"');
    expect(texture).toContain('app:surface_type="texture_view"');
    expect(texture).toContain('app:player_layout_id="@layout/magicbooklet_player_view"');
    expect(texture).toContain('app:use_controller="false"');
    const surface = layout('surface_player_view.xml');
    expect(surface).toContain('android:id="@+id/surface_player_view"');
    expect(surface).toContain('app:surface_type="surface_view"');
    expect(surface).toContain('app:player_layout_id="@layout/magicbooklet_player_view"');
    // The names expo-video inflates (VideoView.kt getPlayerViewLayoutId).
    const kotlin = readFileSync(join(projectRoot, 'node_modules/expo-video/android/src/main/java/expo/modules/video/VideoView.kt'), 'utf8');
    expect(kotlin).toContain('R.layout.texture_player_view');
    expect(kotlin).toContain('R.layout.surface_player_view');
  });

  it('keeps what Media3 and expo-video require, and nothing the app never shows', () => {
    const view = layout('magicbooklet_player_view.xml');
    expect(view).toContain('android:id="@id/exo_content_frame"');
    expect(view).toContain('android:id="@id/exo_shutter"');
    // Media3's controller setters assert a controller; expo-video calls them at
    // construction (fullscreen listener, subtitle button, time bar).
    expect(view).toContain('<androidx.media3.ui.PlayerControlView');
    expect(view).toContain('android:id="@id/exo_controller"');
    expect(view).toContain('app:controller_layout_id="@layout/magicbooklet_player_controls"');
    for (const dropped of ['exo_buffering', 'exo_artwork', 'exo_image', 'exo_error_message', 'exo_ad_overlay', 'exo_overlay', 'exo_controller_placeholder', 'exo_subtitles']) {
      expect(view).not.toContain(dropped);
    }
    const controls = layout('magicbooklet_player_controls.xml');
    // The one lookup expo-video makes without a null check (exitFullscreen).
    expect(controls).toContain('android:id="@id/exo_fullscreen"');
    expect(controls).toContain('android:visibility="gone"');
    expect(controls).not.toContain('exo_play_pause');
    expect(controls).not.toContain('exo_progress');
  });

  it('writes the four layouts into the generated app project', () => {
    const root = mkdtempSync(join(tmpdir(), 'light-player-view-'));
    try {
      const written = writeLightPlayerViewLayouts(root);
      expect(written).toHaveLength(LAYOUT_FILES.length);
      for (const file of LAYOUT_FILES) {
        const output = ['texture_player_view.xml', 'surface_player_view.xml'].includes(file) ? `magicbooklet_${file}` : file;
        expect(readFileSync(join(root, 'android/app/src/main/res/layout', output), 'utf8')).toBe(layout(file));
      }
      expect(existsSync(join(root, 'android/app/src/main/res/layout/texture_player_view.xml'))).toBe(false);
      expect(existsSync(join(root, 'android/app/src/main/res/layout/surface_player_view.xml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is registered only in the commit a store build is made from', () => {
    // Registering it moves both runtime fingerprints (app.json is a fingerprint
    // input), which strands every JS-only update to the shipped binaries. Until
    // that build, ota-targets.json still describes builds without it.
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const registered = (appJson.expo.plugins as unknown[]).some((entry) => (Array.isArray(entry) ? entry[0] : entry) === './plugins/withAndroidLightPlayerView');
    const targets = JSON.parse(readFileSync(join(projectRoot, 'ota-targets.json'), 'utf8'));
    if (registered) {
      expect(targets.targets.android.$note).toContain('withAndroidLightPlayerView');
    } else {
      expect(registered).toBe(false);
    }
  });
});
