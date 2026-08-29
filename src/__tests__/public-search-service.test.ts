import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decodePublicSearchCursor } from '@/lib/public-search';
import { searchPublicContent } from '@/lib/public-search-service';

describe('public search service', () => {
  it('hydrates ranked post ids through the canonical feed mapper and emits a keyset cursor', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name !== 'search_public_posts') throw new Error(`Unexpected RPC ${name}`);
      return {
        data: [
          { post_id: '11111111-1111-4111-8111-111111111111', creator_user_id: 'creator-1', search_score: 8.25 },
          { post_id: '22222222-2222-4222-8222-222222222222', creator_user_id: 'creator-2', search_score: 7.5 },
        ],
        error: null,
      };
    });
    const getShowcaseFeedItemsByPostIds = vi.fn(async ({ postIds }: { postIds: string[] }) => (
      postIds.map((id) => ({ id }))
    ));

    const result = await searchPublicContent({
      query: 'product reveal',
      normalizedQuery: 'product reveal',
      type: 'posts',
      cursor: null,
      limit: 1,
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      getShowcaseFeedItemsByPostIds: getShowcaseFeedItemsByPostIds as never,
      loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
    });

    expect(rpc).toHaveBeenCalledWith('search_public_posts', expect.objectContaining({
      p_query: 'product reveal',
      p_limit: 2,
      p_viewer_user_id: 'viewer-1',
    }));
    expect(getShowcaseFeedItemsByPostIds).toHaveBeenCalledWith({
      postIds: ['11111111-1111-4111-8111-111111111111'],
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
    expect(result.posts.items).toEqual([{ id: '11111111-1111-4111-8111-111111111111' }]);
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts')).toEqual({
      version: 1,
      type: 'posts',
      score: 8.25,
      id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('removes blocked creators before any result reaches the response', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          creator_user_id: 'creator-blocked',
          username: 'blocked',
          display_name: 'Blocked Creator',
          bio: null,
          avatar_url: null,
          public_post_count: 4,
          is_following: false,
          search_score: 5,
        },
        {
          creator_user_id: 'creator-visible',
          username: 'visible',
          display_name: 'Visible Creator',
          bio: null,
          avatar_url: null,
          public_post_count: 2,
          is_following: true,
          search_score: 4,
        },
      ],
      error: null,
    }));

    const result = await searchPublicContent({
      query: 'creator',
      normalizedQuery: 'creator',
      type: 'creators',
      cursor: null,
      limit: 20,
      viewerUserId: 'viewer-1',
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      loadBlockedCreatorIds: vi.fn(async () => new Set(['creator-blocked'])) as never,
    });

    expect(result.creators.items).toEqual([expect.objectContaining({
      id: 'creator-visible',
      username: 'visible',
      isFollowing: true,
    })]);
  });
});
