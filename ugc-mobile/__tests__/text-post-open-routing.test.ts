import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A text-only post has no media to fill the immersive reel, so every surface
 * that opens a `ShowcaseFeedItem` has to branch on "is this text?" before it
 * pushes to `/viewer`. Creator profile and the showcase tab each shipped
 * without that branch, which dropped text posts into the reel while their own
 * tiles rendered as text cards.
 *
 * These are source pins rather than render tests because the defect is in the
 * navigation call itself, not in anything the component renders.
 */
describe('text post open routing', () => {
  it('routes creator-profile taps through the shared text-aware helper', () => {
    const source = readFileSync('components/creator-profile-screen.tsx', 'utf8');

    expect(source).toContain('showcaseFeedItemOpenHref({');
    // A direct viewer push here is the bug: it skips the text check entirely.
    expect(source).not.toContain('immersiveViewerHref(');
  });

  it('routes showcase-tab taps through the shared text-aware helper', () => {
    const source = readFileSync('app/(tabs)/showcase.tsx', 'utf8');

    expect(source).toContain('showcaseFeedItemOpenHref({');
    expect(source).not.toContain('immersiveViewerHref(');
  });

  it('keeps the existing text branch on the surfaces that already had one', () => {
    const homeSource = readFileSync('components/home-dashboard.tsx', 'utf8');
    const profileSource = readFileSync('components/profile-dashboard.tsx', 'utf8');
    const profileFeedSource = readFileSync('components/profile-media-feed.tsx', 'utf8');

    expect(homeSource).toContain("if (getHomeFeedCardOpenTarget(card) === 'post')");
    expect(profileSource).toContain("item.previewKind === 'text'");
    expect(profileFeedSource).toContain('immersivePreviewOpenHref(item, options)');
  });

  it('keeps the text predicate in one place', () => {
    const source = readFileSync('lib/immersive-preview-view-model.ts', 'utf8');

    expect(source).toContain('export function showcaseFeedItemOpenHref');
    expect(source).toContain('if (isTextOnlyShowcasePost(item)) {');
  });
});
