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
import { buildImmersiveShowcaseItems } from '../lib/immersive-preview-view-model';
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
