import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  creatorProfileOpening,
  prepareCreatorProfile,
  setCreatorProfilePreparer,
} from '../lib/creator-profile-opening';
import type { ImmersiveSourceData } from '../lib/immersive-preview-source-data';
import { createShowcaseFeedQueryKey, createShowcasePostQueryKey } from '../lib/showcase-feed-query';
import type { ShowcaseCreator, ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';

const LUNA: ShowcaseCreator = { id: 'creator-1', username: 'luna', name: 'Luna Studio', avatar: 'https://cdn.test/luna.jpg' };
const NOVA: ShowcaseCreator = { id: 'creator-2', username: 'nova', name: 'Nova', avatar: null };

function post(id: string, creator: ShowcaseCreator): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: `Post ${id}`,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-01T10:00:00.000Z',
    creator,
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

function lane(items: ShowcaseFeedItem[]): InfiniteData<ShowcaseFeedResponse> {
  return {
    pages: [{ items, pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 } } as unknown as ShowcaseFeedResponse],
    pageParams: [{ offset: 0 }],
  };
}

const homeLaneKey = createShowcaseFeedQueryKey({}, 'viewer-1');

afterEach(() => {
  vi.useRealTimers();
});

describe('creatorProfileOpening', () => {
  it('names the creator as a post of theirs in a lane does, leaving empty what a post does not carry', () => {
    const client = new QueryClient();
    client.setQueryData(homeLaneKey, lane([post('post-2', NOVA), post('post-1', LUNA)]));

    expect(creatorProfileOpening(client, 'luna')).toEqual({
      id: 'creator-1',
      username: 'luna',
      displayName: 'Luna Studio',
      avatarUrl: 'https://cdn.test/luna.jpg',
      bio: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    });
  });

  it.each([
    ['a reel source', ['immersive-preview-source', 'showcase-feed', 'viewer-1', 'post-1'], { showcaseItems: [post('post-1', LUNA)] } satisfies ImmersiveSourceData],
    ['an opened post', createShowcasePostQueryKey('post-1', 'viewer-1'), { success: true, item: post('post-1', LUNA) }],
    ['an opened post kept bare', createShowcasePostQueryKey('post-1', undefined), post('post-1', LUNA)],
    ['the Saved list', ['profile-saved-media', 'viewer-1'], lane([post('post-1', LUNA)])],
  ])('finds them in %s too', (_cache, queryKey, data) => {
    const client = new QueryClient();
    client.setQueryData(queryKey, data);

    expect(creatorProfileOpening(client, 'luna')).toMatchObject({ id: 'creator-1', displayName: 'Luna Studio' });
  });

  it('draws them as their most recently read post does', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    client.setQueryData(homeLaneKey, lane([post('post-1', { ...LUNA, name: 'Luna (old)', avatar: 'https://cdn.test/old.jpg' })]));
    vi.setSystemTime(new Date('2026-11-03T10:05:00Z'));
    client.setQueryData(createShowcasePostQueryKey('post-7', 'viewer-1'), { success: true, item: post('post-7', LUNA) });

    expect(creatorProfileOpening(client, 'luna')).toMatchObject({ displayName: 'Luna Studio', avatarUrl: 'https://cdn.test/luna.jpg' });
  });

  it('finds nothing rather than guess', () => {
    const client = new QueryClient();
    client.setQueryData(homeLaneKey, lane([
      post('post-2', NOVA),
      // No id to say whose page it is, or no name to draw.
      post('post-3', { ...LUNA, id: null }),
      post('post-4', { ...LUNA, name: '  ' }),
    ]));
    // A creator's own grid is the page's data, not a post to draw it from.
    client.setQueryData(['creator-profile', 'infinite', 'luna-studio'], {
      pages: [{ items: [post('post-5', LUNA)] }],
      pageParams: [0],
    });

    expect(creatorProfileOpening(client, 'luna')).toBeNull();
    // A handle routed in another spelling (a typed link) matches no post.
    client.setQueryData(homeLaneKey, lane([post('post-1', LUNA)]));
    expect(creatorProfileOpening(client, 'Luna')).toBeNull();
    expect(creatorProfileOpening(client, '  ')).toBeNull();
    expect(creatorProfileOpening(new QueryClient(), 'luna')).toBeNull();
  });

  it('reads past entries of another shape', () => {
    const client = new QueryClient();
    client.setQueryData(['showcase-feed', 'infinite', 'viewer-1', 'odd'], { pages: [null, { items: [null] }] });
    client.setQueryData(['immersive-preview-source', 'generation'], { generations: [] });
    client.setQueryData(createShowcasePostQueryKey('post-1', 'viewer-1'), { success: true, item: post('post-1', LUNA) });

    expect(creatorProfileOpening(client, 'luna')).toMatchObject({ id: 'creator-1' });
  });
});

describe('prepareCreatorProfile', () => {
  it('hands the handle, trimmed, to the preparer installed at the root', () => {
    const preparer = vi.fn();
    const remove = setCreatorProfilePreparer(preparer);

    prepareCreatorProfile('  luna ');
    prepareCreatorProfile('');
    prepareCreatorProfile(null);
    prepareCreatorProfile(undefined);
    expect(preparer.mock.calls).toEqual([['luna']]);

    remove();
    prepareCreatorProfile('luna');
    expect(preparer).toHaveBeenCalledTimes(1);
  });

  it('leaves a preparer installed after it in place when the first is taken out', () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = setCreatorProfilePreparer(first);
    const removeSecond = setCreatorProfilePreparer(second);

    removeFirst();
    prepareCreatorProfile('luna');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('luna');
    removeSecond();
  });
});
