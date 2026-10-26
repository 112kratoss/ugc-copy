import { describe, expect, it } from 'vitest';

import {
  HOME_SHELF_MAX_CREATIONS,
  arrangeHomeShelf,
  buildHomeShelfMakeHref,
  selectHomeShelfActions,
  toHomeShelfCreation,
  type HomeShelfAction,
  type HomeShelfActionFacts,
  type HomeShelfCreation,
  type HomeShelfCreationFacts,
} from '@/lib/home-shelf';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

function media(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.example.test/source.mp4',
    previewUrl: 'https://cdn.example.test/poster.webp',
    previewThumbhash: 'thumb',
    feedStreamUrl: 'https://cdn.example.test/stream.mp4',
    mediaKind: 'video',
    contentType: 'video/mp4',
    originalName: null,
    width: 720,
    height: 1280,
    durationSeconds: 6,
    sortOrder: 0,
    ...overrides,
  };
}

function post(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.test/source.mp4',
    mediaKind: 'video',
    mediaItems: [media()],
    model: 'Grok Imagine Video',
    title: 'Paper boat on a sunlit pond',
    prompt: 'A paper boat drifting slowly across a sunlit pond',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-25T00:00:00.000Z',
    creator: { id: 'user-1', username: 'magicbooklet', name: 'Magicbooklet Team', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'generation-1',
    asset: null,
    canRemix: true,
    remixCapability: 'public',
    remixTarget: 'video',
    ...overrides,
  } as ShowcaseFeedItem;
}

const facts: HomeShelfCreationFacts = {
  modelName: 'Grok Imagine',
  price: { kind: 'credits', credits: 15 },
  welcomeCredits: 25,
};

function creation(id: string): HomeShelfCreation {
  const card = toHomeShelfCreation(post({ id }), { postId: id }, facts);
  if (!card) throw new Error('fixture post should qualify');
  return card;
}

const actionFacts: HomeShelfActionFacts = {
  referral: { inviterPercent: 5, inviteePercent: 5 },
  earnEnabled: true,
  creatorSharePercent: 85,
};

describe('toHomeShelfCreation', () => {
  it('turns a remixable pinned post into a card that opens its remix', () => {
    expect(toHomeShelfCreation(post(), { postId: 'post-1', badge: 'new-model' }, facts)).toEqual({
      kind: 'creation',
      id: 'post-1',
      title: 'Paper boat on a sunlit pond',
      tool: 'video',
      posterUrl: 'https://cdn.example.test/poster.webp',
      posterThumbhash: 'thumb',
      clipUrl: 'https://cdn.example.test/stream.mp4',
      modelName: 'Grok Imagine',
      price: { kind: 'credits', credits: 15 },
      fitsWelcomeCredits: true,
      badge: 'new-model',
      creator: { id: 'user-1', username: 'magicbooklet', name: 'Magicbooklet Team' },
      makeHref: '/create-video?remix=generation-1&remixPost=post-1',
    });
  });

  it('leaves out posts a one-tap card cannot make', () => {
    const pin = { postId: 'post-1' };

    // Remix sold with a recipe: it needs the unlock sheet.
    expect(toHomeShelfCreation(post({ remixCapability: 'unlock_required' }), pin, facts)).toBeNull();
    // An upload from another tool has no generation to restore.
    expect(toHomeShelfCreation(post({ generationId: null }), pin, facts)).toBeNull();
    expect(toHomeShelfCreation(post({ remixTarget: 'workflow' }), pin, facts)).toBeNull();
    expect(toHomeShelfCreation(post({ isNsfw: true }), pin, facts)).toBeNull();
    expect(toHomeShelfCreation(post({ mediaItems: [media({ previewUrl: null })] }), pin, facts)).toBeNull();
    expect(toHomeShelfCreation(
      post({ mediaItems: [media({ sourceUnavailableAt: '2026-10-01T00:00:00.000Z' })] }),
      pin,
      facts,
    )).toBeNull();
    // The titles that greeted visitors on the old feed: never a shelf card.
    expect(toHomeShelfCreation(post({ title: 'test' }), pin, facts)).toBeNull();
    expect(toHomeShelfCreation(post({ title: '   ' }), pin, facts)).toBeNull();
    // A read that answered for another post than the pin named.
    expect(toHomeShelfCreation(post({ id: 'post-2' }), pin, facts)).toBeNull();
  });

  it('reads the poster from the first media by sort order', () => {
    const card = toHomeShelfCreation(post({
      mediaItems: [
        media({ id: 'second', sortOrder: 1, previewUrl: 'https://cdn.example.test/second.webp' }),
        media({ id: 'first', sortOrder: 0, previewUrl: 'https://cdn.example.test/first.webp' }),
      ],
    }), { postId: 'post-1' }, facts);

    expect(card?.posterUrl).toBe('https://cdn.example.test/first.webp');
  });

  it('takes the tool the remix opens, motion included', () => {
    const card = toHomeShelfCreation(post({ creationMode: 'motion', remixTarget: 'motion' }), { postId: 'post-1' }, facts);

    expect(card?.tool).toBe('motion');
    expect(card?.makeHref).toBe('/create-motion?remix=generation-1&remixPost=post-1');
  });

  it('plays a clip only for video media', () => {
    const card = toHomeShelfCreation(post({
      category: 'image',
      remixTarget: 'image',
      mediaItems: [media({ mediaKind: 'image', feedStreamUrl: null })],
    }), { postId: 'post-1' }, facts);

    expect(card?.clipUrl).toBeNull();
    expect(card?.makeHref).toBe('/create-image?remix=generation-1&remixPost=post-1');
  });

  it('offers "free to try" only when the price fits the welcome credits', () => {
    const pin = { postId: 'post-1' };

    expect(toHomeShelfCreation(post(), pin, { ...facts, price: { kind: 'credits', credits: 25 } })?.fitsWelcomeCredits).toBe(true);
    expect(toHomeShelfCreation(post(), pin, { ...facts, price: { kind: 'credits', credits: 70 } })?.fitsWelcomeCredits).toBe(false);
    expect(toHomeShelfCreation(post(), pin, { ...facts, welcomeCredits: null })?.fitsWelcomeCredits).toBe(false);
    expect(toHomeShelfCreation(post(), pin, { ...facts, price: { kind: 'clip-length' } })?.fitsWelcomeCredits).toBe(false);
    expect(toHomeShelfCreation(post(), pin, { ...facts, price: null })?.fitsWelcomeCredits).toBe(false);
  });
});

describe('buildHomeShelfMakeHref', () => {
  it('encodes the ids the create page reads', () => {
    expect(buildHomeShelfMakeHref('motion', 'gen/1', 'post 1')).toBe('/create-motion?remix=gen%2F1&remixPost=post+1');
  });
});

describe('selectHomeShelfActions', () => {
  it('asks a member who has never posted to post, and to invite', () => {
    expect(selectHomeShelfActions({ hasPosted: false }, actionFacts).map((action) => action.id))
      .toEqual(['post', 'invite']);
  });

  it('asks a member who has posted to sell, and to invite', () => {
    expect(selectHomeShelfActions({ hasPosted: true }, actionFacts)).toEqual([
      { kind: 'action', id: 'earn', creatorSharePercent: 85 },
      { kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 },
    ]);
  });

  it('keeps Earn off while its switch is off', () => {
    expect(selectHomeShelfActions({ hasPosted: true }, { ...actionFacts, earnEnabled: false })
      .map((action) => action.id)).toEqual(['invite']);
  });

  it('leaves Invite out while no referral program is running', () => {
    expect(selectHomeShelfActions({ hasPosted: false }, { ...actionFacts, referral: null })
      .map((action) => action.id)).toEqual(['post']);
    expect(selectHomeShelfActions(
      { hasPosted: false },
      { ...actionFacts, referral: { inviterPercent: 0, inviteePercent: 0 } },
    ).map((action) => action.id)).toEqual(['post']);
  });
});

describe('arrangeHomeShelf', () => {
  const post_: HomeShelfAction = { kind: 'action', id: 'post' };
  const invite: HomeShelfAction = { kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 };

  it('renders nothing below three creations', () => {
    expect(arrangeHomeShelf([creation('a'), creation('b')], [post_, invite])).toEqual([]);
  });

  it('puts Post third and Invite last', () => {
    const ids = arrangeHomeShelf(['a', 'b', 'c', 'd'].map(creation), [post_, invite])
      .map((item) => item.id);

    expect(ids).toEqual(['a', 'b', 'post', 'c', 'd', 'invite']);
  });

  it('keeps Invite at the end when it is the only offer', () => {
    const ids = arrangeHomeShelf(['a', 'b', 'c'].map(creation), [invite]).map((item) => item.id);

    expect(ids).toEqual(['a', 'b', 'c', 'invite']);
  });

  it('places offers by what they are, not the order they arrive in', () => {
    const ids = arrangeHomeShelf(['a', 'b', 'c'].map(creation), [invite, post_]).map((item) => item.id);

    expect(ids).toEqual(['a', 'b', 'post', 'c', 'invite']);
  });

  it('caps creations so offers stay a minority', () => {
    const many = Array.from({ length: HOME_SHELF_MAX_CREATIONS + 3 }, (_, index) => creation(`p${index}`));
    const items = arrangeHomeShelf(many, [post_, invite]);

    expect(items.filter((item) => item.kind === 'creation')).toHaveLength(HOME_SHELF_MAX_CREATIONS);
    expect(items.filter((item) => item.kind === 'action')).toHaveLength(2);
  });
});
