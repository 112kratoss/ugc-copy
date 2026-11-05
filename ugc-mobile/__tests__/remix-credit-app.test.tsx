// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => {
  const host = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  return {
    Platform: { OS: 'ios' },
    Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
    Text: host('text'),
    View: host('view'),
  };
});
vi.mock('lucide-react-native', () => ({ Repeat2: () => React.createElement('icon') }));
vi.mock('@/lib/theme-context', async () => {
  const { appTheme } = await import('../lib/theme');
  return { useAppTheme: () => ({ ...appTheme, colors: { text: '#111', muted: '#666' } }) };
});

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { RemixCreditLine } from '../components/remix-credit-line';
import { buildImmersiveShowcaseItems, unnameCreatorInImmersiveItems } from '../lib/immersive-preview-view-model';
import { removeBlockedCreatorFromInfiniteData } from '../lib/showcase-feed-events';
import { buildPostDetailsMeta, postRemixesLink } from '../lib/post-details-view-model';
import {
  hasUnpostedRemixes,
  nextPostRemixesOffset,
  postRemixRowLabel,
  postRemixThumbnailUrl,
  postRemixesFromPages,
} from '../lib/post-remixes-view-model';
import { remixCreditLabel, type RemixCredit } from '../lib/remix-credit/remix-credit';
import type { PostRemixesResponse, ShowcaseFeedItem } from '../lib/types';

/**
 * Owner, 2026-11-05 (A posts, B remixes A, C remixes B): every remix post says
 * "Remix of “title” by @A", and "· Original by @A" when the chain began with
 * someone else, on the post page, the reel and the cards; A's remix count opens
 * the remixes. The words are the web's (`lib/remix-credit`); the server leaves
 * out what the viewer may not see.
 */

const variants = mobileApiContract.endpoints.getShowcasePost.responseVariants;

describe('the credit the cards carry', () => {
  it.each([
    ['remix', variants.remix.item, 'Remix of “Launch frame” by @creator'],
    ['remixOfRemix', variants.remixOfRemix.item, 'Remix of “Launch frame, at night” by @maya · Original by @creator'],
    ['remixOfRemovedPost', variants.remixOfRemovedPost.item, 'Original by @creator'],
  ])('reaches the reel and Details as the server pinned it (%s)', (_variant, item, label) => {
    const [reelItem] = buildImmersiveShowcaseItems('showcase-feed', [item as unknown as ShowcaseFeedItem]);
    expect(reelItem.details?.remixCredit).toEqual(item.remixCredit);
    expect(remixCreditLabel(reelItem.details!.remixCredit!)).toBe(label);
  });

  it('carries none for a post that is no remix, or a credit that is malformed', () => {
    const post = mobileApiContract.endpoints.getShowcasePost.response.item as unknown as ShowcaseFeedItem;
    const [plain] = buildImmersiveShowcaseItems('showcase-feed', [post]);
    expect(plain.details).not.toHaveProperty('remixCredit');
    const [malformed] = buildImmersiveShowcaseItems('showcase-feed', [
      { ...post, remixCredit: { parent: { postId: 'p', title: 'T', creator: { id: 'u', username: 'a b' } }, original: null } } as unknown as ShowcaseFeedItem,
    ]);
    expect(malformed.details).not.toHaveProperty('remixCredit');
  });
});

describe('the credit line', () => {
  const chain: RemixCredit = {
    parent: { postId: 'post-b', title: 'Sunset, again', creator: { id: 'user-maya', username: 'maya' } },
    original: { id: 'user-cora', username: 'cora' },
  };

  function draw(credit: RemixCredit | null) {
    const onOpenPost = vi.fn();
    const onOpenCreator = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RemixCreditLine remixCredit={credit} onOpenPost={onOpenPost} onOpenCreator={onOpenCreator} />);
    });
    return { tree, onOpenPost, onOpenCreator };
  }

  it('reads as one link, in the shared words, and opens the post remixed', () => {
    const { tree, onOpenPost, onOpenCreator } = draw(chain);
    const link = tree.root.findByProps({ testID: 'remix-credit' });
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityLabel).toBe('Remix of “Sunset, again” by @maya · Original by @cora');
    act(() => { link.props.onPress(); });
    expect(onOpenPost).toHaveBeenCalledWith('post-b');
    expect(onOpenCreator).not.toHaveBeenCalled();
  });

  it('opens the original creator when the post remixed can no longer be shown', () => {
    const { tree, onOpenCreator } = draw({ parent: null, original: { id: 'user-cora', username: 'cora' } });
    const link = tree.root.findByProps({ testID: 'remix-credit' });
    expect(link.props.accessibilityHint).toBe('Opens their profile');
    act(() => { link.props.onPress(); });
    expect(onOpenCreator).toHaveBeenCalledWith('cora');
  });

  // Held to two lines (cards, the reel), a long title is shortened so the original keeps its room.
  it('shortens a long title on a held line, and VoiceOver hears it whole', () => {
    const long = { ...chain, parent: { ...chain.parent!, title: 'A very long title about a coral sunset over a quiet beach at dawn' } };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RemixCreditLine remixCredit={long} numberOfLines={2} onOpenPost={vi.fn()} onOpenCreator={vi.fn()} />);
    });
    const link = tree.root.findByProps({ testID: 'remix-credit' });
    const shown = link.findAllByType('text' as never).map((node) => node.children.filter((child) => typeof child === 'string').join('')).join('');
    expect(shown).toContain('“A very long title about a coral…”');
    expect(shown).toContain('Original by');
    expect(link.props.accessibilityLabel).toContain('A very long title about a coral sunset over a quiet beach at dawn');
  });

  it('draws nothing for a post that is no remix', () => {
    const { tree } = draw(null);
    expect(tree.toJSON()).toBeNull();
  });
});

describe('the remix count on Details', () => {
  const post = mobileApiContract.endpoints.getShowcasePost.response.item as unknown as ShowcaseFeedItem;

  it('is the link to the post\'s remixes, taking the count with it, and leaves the line', () => {
    const [item] = buildImmersiveShowcaseItems('showcase-feed', [{ ...post, remixCount: 3 }]);
    expect(postRemixesLink(item)).toEqual({
      postId: 'post-1',
      label: '3 remixes',
      href: '/post/remixes/post-1?remixCount=3',
    });
    expect(buildPostDetailsMeta(item, new Date(), { remixesOnLink: true }).metaParts).not.toContain('3 remixes');
    expect(buildPostDetailsMeta(item).metaParts).toContain('3 remixes');
  });

  it('opens nothing for a post with no remixes yet', () => {
    const [item] = buildImmersiveShowcaseItems('showcase-feed', [{ ...post, remixCount: 0 }]);
    expect(postRemixesLink(item)).toBeNull();
  });
});

describe('the remixes list', () => {
  const remix = mobileApiContract.endpoints.listPostRemixes.response.items[0] as unknown as ShowcaseFeedItem;
  const page = (items: ShowcaseFeedItem[], hasMore: boolean, nextOffset: number | null): PostRemixesResponse => ({
    success: true,
    items,
    pageInfo: { hasMore, nextOffset, limit: 24, offset: 0 },
  });

  it('lists each remix once across its pages, and pages on until the last', () => {
    const second = { ...remix, id: 'post-remix-9' };
    expect(postRemixesFromPages([page([remix], true, 24), page([remix, second], false, null)]).map((item) => item.id))
      .toEqual(['post-remix-1', 'post-remix-9']);
    expect(nextPostRemixesOffset(page([remix], true, 24))).toBe(24);
    expect(nextPostRemixesOffset(page([remix], false, null))).toBeUndefined();
  });

  it('says so when some remixes were never posted, once the list is whole', () => {
    expect(hasUnpostedRemixes(1, 3, false)).toBe(true);
    expect(hasUnpostedRemixes(1, 3, true)).toBe(false);
    expect(hasUnpostedRemixes(3, 3, false)).toBe(false);
  });

  it('draws a row from the card the list sends', () => {
    expect(postRemixRowLabel(remix)).toBe('Launch frame, at night, by @maya');
    expect(postRemixThumbnailUrl(remix)).toBe('https://cdn.example.test/post-1.png');
    expect(postRemixThumbnailUrl({ mediaItems: [], mediaKind: null, mediaUrl: null })).toBeNull();
  });
});

// Owner, 2026-11-05: nobody a block stands between the viewer and is named. A block in the app takes
// the creator's own posts out (as before) and their name out of the credits of the posts that stay,
// as the server leaves them at the next read.
describe('a block, in what the app holds', () => {
  const chain = variants.remixOfRemix.item as unknown as ShowcaseFeedItem;
  const parentCreatorId = chain.remixCredit!.parent!.creator.id;
  const originalId = chain.remixCredit!.original!.id;
  const plain = mobileApiContract.endpoints.getShowcasePost.response.item as unknown as ShowcaseFeedItem;
  const lane = (items: ShowcaseFeedItem[]) => ({
    pageParams: [0],
    pages: [{ success: true, items, pageInfo: { hasMore: false, nextOffset: null, limit: 24, offset: 0 } }],
  }) as never;

  it('takes the name out of a lane\'s credits, keeping the rest of the credit', () => {
    const data = removeBlockedCreatorFromInfiniteData(lane([chain, plain]), parentCreatorId) as unknown as { pages: Array<{ items: ShowcaseFeedItem[] }> };
    const [remix] = data.pages[0].items;
    expect(remix.remixCredit).toEqual({ parent: null, original: chain.remixCredit!.original });
    expect(data.pages[0].items).toHaveLength(2);
  });

  it('drops a credit with no one left to name, and hands back what no credit names', () => {
    const both = removeBlockedCreatorFromInfiniteData(
      removeBlockedCreatorFromInfiniteData(lane([chain]), parentCreatorId),
      originalId,
    ) as unknown as { pages: Array<{ items: ShowcaseFeedItem[] }> };
    expect(both.pages[0].items[0]).not.toHaveProperty('remixCredit');
    const untouched = removeBlockedCreatorFromInfiniteData(lane([chain, plain]), 'someone-else') as unknown as { pages: Array<{ items: ShowcaseFeedItem[] }> };
    expect(untouched.pages[0].items[0]).toBe(chain);
    expect(untouched.pages[0].items[1]).toBe(plain);
  });

  // A posts, B remixes A, A remixes B: blocking B leaves A's own post no "Original by @A" alone.
  it('never leaves a lone original naming the post\'s own creator', () => {
    const credit = { parent: { postId: 'post-b', title: 'Sunset, again', creator: { id: 'user-b', username: 'maya' } }, original: { id: 'user-a', username: 'cora' } };
    const [own] = buildImmersiveShowcaseItems('showcase-feed', [{ ...chain, creator: { ...chain.creator, id: 'user-a' }, remixCredit: credit } as ShowcaseFeedItem]);
    const [unnamed] = unnameCreatorInImmersiveItems([own], 'user-b');
    expect(unnamed.details).not.toHaveProperty('remixCredit');
  });

  it('takes the name out of the reel\'s Details, and hands back what no credit names', () => {
    const reel = buildImmersiveShowcaseItems('showcase-feed', [chain, plain]);
    const [remix, other] = unnameCreatorInImmersiveItems(reel, parentCreatorId);
    expect(remix.details?.remixCredit).toEqual({ parent: null, original: chain.remixCredit!.original });
    expect(other).toBe(reel[1]);
    expect(unnameCreatorInImmersiveItems(reel, 'someone-else')).toBe(reel);
  });
});
