import { describe, expect, it, vi } from 'vitest';

import {
  SHOWCASE_DELIVERY_QUERY_PARAM,
  buildShowcaseDetailPath,
  getShowcaseReturnContext,
  stripShowcaseViewerState,
} from '@/lib/share';
import { sharePublicGeneration } from '@/lib/share-client';

describe('showcase navigation', () => {
  it('builds canonical recipe links and removes transient reel state from return paths', () => {
    expect(buildShowcaseDetailPath('post-1', {
      from: 'profile',
      returnTo: '/profile?tab=saved&post=post-1&media=2',
      section: 'resources',
    })).toBe('/showcase/post-1?from=profile&returnTo=%2Fprofile%3Ftab%3Dsaved#recipe');
  });

  it('preserves useful filters and hashes while removing reel-only parameters', () => {
    expect(stripShowcaseViewerState('/showcase?category=video&post=post-1&media=2#top'))
      .toBe('/showcase?category=video#top');
  });

  it('returns profile details to the owner media hub without reopening the reel', () => {
    expect(getShowcaseReturnContext({
      from: 'profile',
      returnTo: '/profile?tab=posts&post=post-1',
    })).toEqual({
      source: 'profile',
      href: '/profile?tab=posts',
      label: 'Back to Your Profile',
    });
  });

  it('rejects external return destinations', () => {
    expect(getShowcaseReturnContext({ returnTo: '//evil.example/path' })).toEqual({
      source: 'community',
      href: '/showcase',
      label: 'Back to Community',
    });
  });

  // A report or a comment on the post page is credited to the ranked card that
  // opened it only if the card's delivery reaches the page, as the app's post
  // route carries `deliveryId`.
  describe("a ranked card's delivery", () => {
    it('rides on the link the card opens, after the return context', () => {
      expect(SHOWCASE_DELIVERY_QUERY_PARAM).toBe('delivery');
      expect(buildShowcaseDetailPath('post-1', {
        from: 'home',
        returnTo: '/?chip=notes',
        deliveryId: '4242',
      })).toBe('/showcase/post-1?from=home&returnTo=%2F%3Fchip%3Dnotes&delivery=4242');
      expect(buildShowcaseDetailPath('post-1', {
        from: 'home',
        returnTo: '/',
        deliveryId: '4242',
        section: 'resources',
      })).toBe('/showcase/post-1?from=home&returnTo=%2F&delivery=4242#recipe');
    });

    it('is left out when the card has none', () => {
      expect(buildShowcaseDetailPath('post-1', { from: 'home', returnTo: '/', deliveryId: null }))
        .toBe('/showcase/post-1?from=home&returnTo=%2F');
      expect(buildShowcaseDetailPath('post-1', { deliveryId: '  ' })).toBe('/showcase/post-1');
    });

    it('is dropped from a return path, with the reel state and the share marker', () => {
      const openedPostPage = '/showcase/post-1?from=home&returnTo=%2F&delivery=4242&s=feed&post=post-1';

      expect(stripShowcaseViewerState(openedPostPage)).toBe('/showcase/post-1?from=home&returnTo=%2F');
      expect(buildShowcaseDetailPath('post-2', { from: 'community', returnTo: openedPostPage }))
        .toBe(`/showcase/post-2?from=community&returnTo=${encodeURIComponent('/showcase/post-1?from=home&returnTo=%2F')}`);
      expect(getShowcaseReturnContext({ from: 'home', returnTo: '/?chip=notes&delivery=4242' })).toEqual({
        source: 'home',
        href: '/?chip=notes',
        label: 'Back to Home',
      });
    });

    it('never goes out in a share link, nor into the canonical path', async () => {
      // The post page a Home card opened, shared by copying its link.
      window.history.pushState({}, '', '/showcase/post-1?from=home&returnTo=%2F&delivery=4242');
      const writeText = vi.fn(async (text: string) => {
        void text;
      });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));

      try {
        await expect(sharePublicGeneration({
          generationId: 'post-1',
          title: 'Shared creation',
          sourceSurface: 'detail-page',
        })).resolves.toBe('copy-link');
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/showcase/post-1?s=detail-page`);
        expect(buildShowcaseDetailPath('post-1')).toBe('/showcase/post-1');
      } finally {
        window.history.pushState({}, '', '/');
        Reflect.deleteProperty(navigator, 'share');
        Reflect.deleteProperty(navigator, 'clipboard');
        vi.unstubAllGlobals();
      }
    });
  });
});
