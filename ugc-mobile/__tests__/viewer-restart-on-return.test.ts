import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const viewer = readFileSync(join(__dirname, '..', 'app', 'viewer.tsx'), 'utf8');

describe('the reel restarts a post the reader scrolled away from', () => {
  it('rewinds when the slide is left, not when playback merely pauses', () => {
    const effect = viewer.slice(viewer.indexOf('const wasOnSlideRef'), viewer.indexOf('}, [player, slideActive]);'));
    expect(effect).toContain('if (slideActive) {');
    expect(effect).toContain('player.currentTime = 0;');
    // Overlays flip `active` (playback) but leave `slideActive` alone.
    expect(effect).not.toMatch(/\bactive\b(?!Video)/);
  });

  it('feeds the slide flag from the reel, separately from playback', () => {
    expect(viewer).toContain('active={videoPlaybackActive}\n          slideActive={active}');
    expect(viewer).toContain("active={active && currentHorizontalIndex === pageIndex && (page.type !== 'media' || videoPlaybackActive)}\n            slideActive={active}");
  });
});
