import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

/**
 * A video post closes back into its tile without changing picture: the reel
 * hands the tile the player it carried away (lib/video-player-loans.ts) instead
 * of the tile building a new one, which showed the poster — the clip's first
 * frame — and then took the clip up somewhere else. The ownership rules are unit
 * tested; these guard the timing seams in the zoom and the reel, which only a
 * device shows going wrong.
 */
describe('a video post closing into its tile', () => {
  it('is told which video the reel is showing and which player draws it', () => {
    const viewer = read('app/viewer.tsx');
    expect(viewer).toContain('activeVideoUrl: activeMedia.playbackUrl,');
    expect(viewer).toContain('playerFor: playbackHandoff.playerFor,');
  });

  it('leaves a handed-back player alone as the reel loses focus', () => {
    expect(read('app/viewer.tsx')).toContain('if (!isVideoPlayerHandedBack(player)) player.pause();');
    expect(read('lib/viewer-playback-handoff.ts')).toContain('if (isVideoPlayerHandedBack(player)) return;');
  });

  it('lands a live close in the tile and pops only once the reel is out of sight', () => {
    const zoom = read('components/media-zoom.tsx');
    expect(zoom).toMatch(
      /if \(event\.type === 'landed' && close\.live\) \{\s*if \(close\.dissolves\) \{\s*stageOpacity\.set\(0\);\s*leave\(\);\s*\} else \{\s*leaveIntoTile\(\);/
    );
    // Reanimated holds its commits while React commits: a hide set together with
    // the pop reached the screen with the pop, ~50 ms after the tile had drawn.
    const leaveIntoTile = zoom.slice(zoom.indexOf('const leaveIntoTile = useCallback('));
    const letGo = leaveIntoTile.slice(0, leaveIntoTile.indexOf('}, [leave, returnableVideo, stageOpacity]);'));
    expect(letGo).toContain('stageOpacity.set(withTiming(0, { duration: 0 }, () => {');
    expect(letGo).toContain('runOnJS(leave)();');
  });

  it('dissolves a video the tile will not take back into the tile as the close lands', () => {
    // A long clip's tile plays a teaser, and a tile that never lent its player
    // builds a new one: either shows its poster, the clip's first frame, and
    // starts over. Filmed on the emulator (a Seedance teaser on Home), the reel
    // stood frozen over that tile for 0.3–0.4 s and then cut to the first frame,
    // which on a moving clip read as the picture jumping.
    const zoom = read('components/media-zoom.tsx');
    expect(zoom).toContain('const dissolves = live && Boolean(activeVideoUrlRef.current) && !returnableVideo();');
    expect(zoom).toContain(
      'stageOpacity.value * interpolate(flightTime.value, [0, CLOSE_DISSOLVE_FROM], [0, 1], Extrapolation.CLAMP)'
    );
    // Only over the stretch where the window has all but reached the tile, so
    // the two pictures barely part as they cross.
    const from = Number(zoom.match(/const CLOSE_DISSOLVE_FROM = ([\d.]+);/)?.[1]);
    const power = Number(zoom.match(/const ZOOM_EASE_POWER = ([\d.]+);/)?.[1]);
    expect(from ** power).toBeLessThan(0.1);
  });

  it('fades the reel as one surface', () => {
    // Android's per-child alpha drew the window's black ground and letterbox at
    // the dissolve's alpha under the picture: a landscape clip darkened to near
    // black before the tile showed through.
    const zoom = read('components/media-zoom.tsx');
    const stage = zoom.slice(zoom.indexOf('export function MediaZoomStage('));
    expect(stage.slice(0, stage.indexOf('style={[{ flex: 1 }, stage.stageStyle]}'))).toContain(
      'needsOffscreenAlphaCompositing'
    );
  });

  it('never hides the tile once a close has begun', () => {
    // The hand-off fade's callback can outlast a quick close; hiding the tile
    // then left it empty after the reel had gone.
    expect(read('components/media-zoom.tsx')).toContain(
      'if (!dismissingRef.current && !leftRef.current) holdTile(activeItemRef.current);'
    );
  });
});
