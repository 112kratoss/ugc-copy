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
    expect(zoom).toContain("if (event.type === 'landed' && close.live) leaveIntoTile();");
    // Reanimated holds its commits while React commits: a hide set together with
    // the pop reached the screen with the pop, ~50 ms after the tile had drawn.
    const leaveIntoTile = zoom.slice(zoom.indexOf('const leaveIntoTile = useCallback('));
    const letGo = leaveIntoTile.slice(0, leaveIntoTile.indexOf('}, [leave, returnableVideo, stageOpacity]);'));
    expect(letGo).toContain('stageOpacity.set(withTiming(0, { duration: 0 }, () => {');
    expect(letGo).toContain('runOnJS(leave)();');
  });

  it('never hides the tile once a close has begun', () => {
    // The hand-off fade's callback can outlast a quick close; hiding the tile
    // then left it empty after the reel had gone.
    expect(read('components/media-zoom.tsx')).toContain(
      'if (!dismissingRef.current && !leftRef.current) holdTile(activeItemRef.current);'
    );
  });
});
