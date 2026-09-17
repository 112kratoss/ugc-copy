import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { drawsPreparedFollowPill } from '../lib/reel-overlay-view-model';

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

/**
 * A post grows out of its tile whole: the window carries the reel's own rail,
 * caption and controls from the first frame, rather than a bare picture the reel
 * dresses once it lands. That only holds while both draw the same component from
 * the same item, so these guard the seam between them.
 */
describe('a post grows out of its tile whole', () => {
  it('draws one chrome, in the reel and in the window it grows in', () => {
    expect(read('app/viewer.tsx')).toContain('<ReelSlideChrome');
    expect(read('components/zoom-post-chrome.tsx')).toContain('<ReelSlideChrome');
    for (const file of ['app/viewer.tsx', 'components/zoom-post-chrome.tsx']) {
      expect(read(file)).toContain("from '@/components/reel-chrome'");
    }
  });

  it('hands the flight the post every zooming tile shows', () => {
    for (const file of [
      'app/(tabs)/showcase.tsx',
      'components/home-feed-card.tsx',
      'components/creator-profile-screen.tsx',
    ]) {
      expect(read(file)).toContain('post: buildImmersiveShowcaseItems(');
    }
  });

  it('carries the post out of the tile and back down into it', () => {
    const zoom = read('components/media-zoom.tsx');
    // A live close shrinks the reel itself, which has chrome of its own; the
    // layer draws the post only for the close that shrinks its picture.
    expect(zoom).toContain('const post = live ? null : postRef.current;');
    // The shade is part of the post now, so the flight draws only one of them.
    expect(zoom).toContain('carriesPost ? null : (');
  });

  it('keeps the drawn copy away from a screen reader', () => {
    const zoom = read('components/media-zoom.tsx');
    const wrapper = zoom.slice(Math.max(0, zoom.indexOf('{postChrome}') - 600), zoom.indexOf('{postChrome}'));
    expect(wrapper).toContain('accessibilityElementsHidden');
    expect(wrapper).toContain('importantForAccessibility="no-hide-descendants"');
  });

  it('fades a closing post rather than cutting its chrome away', () => {
    const zoom = read('components/media-zoom.tsx');
    // Both the reel's own chrome (a live close) and the layer's copy of it.
    const fades = zoom.match(/\[CLOSE_CHROME_GONE, CLOSE_CHROME_HOLD\], \[0, 1\], Extrapolation\.CLAMP/g);
    expect(fades?.length).toBe(2);
  });
});

describe('the Follow pill on a post drawn before its reel', () => {
  const followTarget = { creatorId: 'creator-1' };

  it('shows for a signed-out reader, who is always offered it', () => {
    expect(drawsPreparedFollowPill({ followTarget, signedIn: false, followKnown: false })).toBe(true);
  });

  it('waits for the answer when somebody is signed in', () => {
    expect(drawsPreparedFollowPill({ followTarget, signedIn: true, followKnown: false })).toBe(false);
    expect(drawsPreparedFollowPill({ followTarget, signedIn: true, followKnown: true })).toBe(true);
  });

  it('draws nothing where the reel would offer nothing', () => {
    expect(drawsPreparedFollowPill({ followTarget: null, signedIn: false, followKnown: true })).toBe(false);
  });
});
