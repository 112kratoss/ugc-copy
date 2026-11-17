import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  logBackendError: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: cacheMocks.revalidateTag,
  unstable_cache: (read: unknown) => read,
}));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: cacheMocks.logBackendError }));

import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import {
  PUBLIC_PAGE_CACHE_TAG,
  PUBLIC_PAGE_REFRESH_TAG,
  publicCreatorHandleTag,
  publicCreatorPageTag,
  publicPostArrivalTag,
  publicPostPageTag,
} from '@/lib/public-page-cache';
import {
  invalidateShowcaseFeedAndRefreshEveryPage,
  invalidateShowcaseFeedAndRefreshPostPages,
  invalidateShowcaseFeedCache,
  invalidateShowcaseFeedCacheOnly,
  REMIX_PAGE_REFRESH_LIMIT,
  SHOWCASE_FEED_CACHE_TAG,
} from '@/lib/showcase-feed-cache';

const AT_ONCE = { expire: 0 };
const IN_THE_BACKGROUND = 'max';

/** The remix lookup the post-pages refresh makes: the posts whose credit names the post. */
function remixesClient(answer: { data?: Array<{ id: string; user_id: string | null }> | null; error?: unknown; throws?: boolean }) {
  const calls: Array<{ table: string; columns: string; filter: [string, unknown]; limit: number; signal: boolean }> = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: unknown) {
              return {
                limit(limit: number) {
                  return {
                    abortSignal(signal: AbortSignal) {
                      calls.push({ table, columns, filter: [column, value], limit, signal: signal instanceof AbortSignal });
                      if (answer.throws) throw new Error('network down');
                      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const post = { postId: 'POST-1', generationId: 'gen-1', creatorId: 'creator-1' };

describe('showcase feed cache', () => {
  beforeEach(() => {
    cacheMocks.revalidateTag.mockClear();
    cacheMocks.logBackendError.mockClear();
  });

  it('expires the feed and every cached public page at once for a removal', () => {
    invalidateShowcaseFeedCache();

    expect(cacheMocks.revalidateTag.mock.calls).toEqual([
      [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
      [PUBLIC_PAGE_CACHE_TAG, AT_ONCE],
    ]);
  });

  // A block or a report, and the hourly feed maintenance: the pages draw
  // none of it, so every cached page stays.
  it('expires the feed tag alone for a change only the feeds show', () => {
    invalidateShowcaseFeedCacheOnly();

    expect(cacheMocks.revalidateTag.mock.calls).toEqual([
      [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
    ]);
  });

  describe('a change to one post', () => {
    it("expires the feed at once and refreshes the post's pages, its creator's and the storefront in the background", async () => {
      const { client, calls } = remixesClient({ data: [] });

      await invalidateShowcaseFeedAndRefreshPostPages(client, { ...post, arrived: false });

      expect(cacheMocks.revalidateTag.mock.calls).toEqual([
        [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
        [publicPostPageTag('post-1'), IN_THE_BACKGROUND],
        // The creation's id is a legacy address of the same page.
        [publicPostPageTag('gen-1'), IN_THE_BACKGROUND],
        [publicCreatorPageTag('creator-1'), IN_THE_BACKGROUND],
        [MARKETPLACE_RESOURCE_LIST_CACHE_TAG, IN_THE_BACKGROUND],
      ]);
      // Never the removal tag, and never every page: the change names its pages.
      expect(cacheMocks.revalidateTag).not.toHaveBeenCalledWith(PUBLIC_PAGE_CACHE_TAG, expect.anything());
      expect(cacheMocks.revalidateTag).not.toHaveBeenCalledWith(PUBLIC_PAGE_REFRESH_TAG, expect.anything());
      expect(calls).toEqual([{
        table: 'posts',
        columns: 'id, user_id',
        filter: ['remix_parent_post_id', 'POST-1'],
        limit: REMIX_PAGE_REFRESH_LIMIT + 1,
        signal: true,
      }]);
    });

    it('drops the not-found a post coming into view may have left on its page, at once', async () => {
      const { client } = remixesClient({ data: [] });

      await invalidateShowcaseFeedAndRefreshPostPages(client, { ...post, arrived: true });

      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicPostArrivalTag('post-1'), AT_ONCE);
      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicPostArrivalTag('gen-1'), AT_ONCE);
      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicPostPageTag('post-1'), IN_THE_BACKGROUND);
    });

    it('refreshes the pages of the remixes that credit the post, and their creators', async () => {
      const { client } = remixesClient({ data: [
        { id: 'remix-1', user_id: 'remixer-1' },
        { id: 'remix-2', user_id: null },
      ] });

      await invalidateShowcaseFeedAndRefreshPostPages(client, { ...post, arrived: false });

      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicPostPageTag('remix-1'), IN_THE_BACKGROUND);
      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicCreatorPageTag('remixer-1'), IN_THE_BACKGROUND);
      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(publicPostPageTag('remix-2'), IN_THE_BACKGROUND);
      expect(cacheMocks.revalidateTag).not.toHaveBeenCalledWith(PUBLIC_PAGE_REFRESH_TAG, expect.anything());
    });

    it.each([
      ['the lookup fails', { error: { message: 'boom' } }],
      ['the lookup throws', { throws: true }],
      ['the remixes are too many to name', {
        data: Array.from({ length: REMIX_PAGE_REFRESH_LIMIT + 1 }, (_, index) => ({ id: `remix-${index}`, user_id: null })),
      }],
    ])('refreshes every page in the background when %s', async (_name, answer) => {
      const { client } = remixesClient(answer);

      await expect(invalidateShowcaseFeedAndRefreshPostPages(client, { ...post, arrived: false })).resolves.toBeUndefined();

      expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(PUBLIC_PAGE_REFRESH_TAG, IN_THE_BACKGROUND);
      expect(cacheMocks.revalidateTag).not.toHaveBeenCalledWith(PUBLIC_PAGE_CACHE_TAG, expect.anything());
      expect(cacheMocks.revalidateTag).not.toHaveBeenCalledWith(publicPostPageTag('remix-0'), expect.anything());
    });

    it('looks for no remix of a post this change made', async () => {
      const { client, calls } = remixesClient({ data: [] });

      await invalidateShowcaseFeedAndRefreshPostPages(client, {
        postId: 'post-new',
        creatorId: 'creator-1',
        arrived: true,
        isNew: true,
      });

      expect(calls).toEqual([]);
      expect(cacheMocks.revalidateTag.mock.calls).toEqual([
        [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
        [publicPostPageTag('post-new'), IN_THE_BACKGROUND],
        [publicPostArrivalTag('post-new'), AT_ONCE],
        [publicCreatorPageTag('creator-1'), IN_THE_BACKGROUND],
        [MARKETPLACE_RESOURCE_LIST_CACHE_TAG, IN_THE_BACKGROUND],
      ]);
    });
  });

  describe('a change whose pages cannot be named', () => {
    it('expires the feed at once and refreshes every public page in the background', () => {
      invalidateShowcaseFeedAndRefreshEveryPage();

      expect(cacheMocks.revalidateTag.mock.calls).toEqual([
        [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
        [PUBLIC_PAGE_REFRESH_TAG, IN_THE_BACKGROUND],
      ]);
    });

    it('drops at once the not-found of a post brought back and of a handle just taken', () => {
      invalidateShowcaseFeedAndRefreshEveryPage({ postIds: ['post-1'], handles: ['@New.Name', '   '] });

      expect(cacheMocks.revalidateTag.mock.calls).toEqual([
        [SHOWCASE_FEED_CACHE_TAG, AT_ONCE],
        [PUBLIC_PAGE_REFRESH_TAG, IN_THE_BACKGROUND],
        [publicPostArrivalTag('post-1'), AT_ONCE],
        [publicCreatorHandleTag('new.name'), AT_ONCE],
      ]);
    });
  });

  // Next keeps one stale time and one expiry per tag: a later 'max' moves an
  // earlier { expire: 0 }'s expiry a year out, and a page drawn before a
  // removal and not visited since would then be served once more. So no tag
  // is ever expired both ways.
  it('expires each tag with one profile only, across every kind of change', async () => {
    const { client } = remixesClient({ data: [{ id: 'remix-1', user_id: 'remixer-1' }] });
    invalidateShowcaseFeedCache();
    invalidateShowcaseFeedCacheOnly();
    await invalidateShowcaseFeedAndRefreshPostPages(client, { ...post, arrived: true });
    await invalidateShowcaseFeedAndRefreshPostPages(remixesClient({ error: { message: 'boom' } }).client, { ...post, arrived: false });
    invalidateShowcaseFeedAndRefreshEveryPage({ postIds: ['post-1'], handles: ['someone'] });

    const profilesByTag = new Map<string, Set<string>>();
    for (const [tag, profile] of cacheMocks.revalidateTag.mock.calls as Array<[string, unknown]>) {
      const kind = profile === IN_THE_BACKGROUND ? 'background' : JSON.stringify(profile) === JSON.stringify(AT_ONCE) ? 'at once' : `other ${JSON.stringify(profile)}`;
      profilesByTag.set(tag, new Set([...(profilesByTag.get(tag) ?? []), kind]));
    }
    for (const [tag, kinds] of profilesByTag) {
      expect([tag, [...kinds]]).toEqual([tag, [expect.stringMatching(/^(background|at once)$/)]]);
    }
    expect(profilesByTag.get(PUBLIC_PAGE_CACHE_TAG)).toEqual(new Set(['at once']));
    expect(profilesByTag.get(PUBLIC_PAGE_REFRESH_TAG)).toEqual(new Set(['background']));
    expect(profilesByTag.get(MARKETPLACE_RESOURCE_LIST_CACHE_TAG)).toEqual(new Set(['background']));
  });
});
