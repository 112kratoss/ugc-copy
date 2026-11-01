import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  HOME_SHELF_START_BLANK_TOOLS,
  formatActiveRenders,
  formatHomeShelfPrice,
  getHomeShelfCardSize,
  homeShelfActionCopy,
  homeShelfBadge,
  homeShelfCreationHint,
  homeShelfCreationLabel,
  homeShelfGuestReturnTo,
  homeShelfPlaybackId,
  homeShelfPosterCacheKey,
  isHomeShelfInView,
  readHomeShelfItems,
  selectHomeShelfPlaybackCandidate,
} from '../lib/home-shelf-view-model';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem, HomeShelfPrice, HomeShelfResponse } from '../lib/types';

const endpoint = mobileApiContract.endpoints.getHomeShelf as unknown as {
  response: HomeShelfResponse;
  responseVariants: Record<'member' | 'memberWhoPosted', { response: HomeShelfResponse }>;
  copy: {
    actions: Record<HomeShelfAction['id'], { title: string; body: string; cta: string }>;
    prices: Array<{ price: HomeShelfPrice; label: string }>;
    badges: Array<{ badge: 'new-model' | null; fitsWelcomeCredits: boolean; offerFreeToTry: boolean; label: string | null }>;
    referralPercents: Array<{ inviterPercent: number; inviteePercent: number; body: string }>;
  };
};

const creations = endpoint.response.items.filter((item): item is HomeShelfCreation => item.kind === 'creation');

describe('readHomeShelfItems', () => {
  it('keeps every card the fixture sends, in order', () => {
    expect(readHomeShelfItems(endpoint.response)).toEqual(endpoint.response.items);
    expect(readHomeShelfItems(endpoint.responseVariants.member.response).map((item) => item.id))
      .toEqual(['post-1', 'post-2', 'post', 'post-3', 'invite']);
  });

  it('skips a card this build does not know, and a creation it could not remix', () => {
    const response = {
      ...endpoint.response,
      items: [
        ...endpoint.response.items,
        { kind: 'challenge', id: 'weekly' },
        { kind: 'action', id: 'giveaway' },
        { ...creations[0], id: 'no-post', post: undefined },
        { ...creations[0], id: 'workflow', tool: 'workflow' },
      ],
    } as unknown as HomeShelfResponse;

    expect(readHomeShelfItems(response).map((item: HomeShelfItem) => item.id)).toEqual(['post-1', 'post-2', 'post-3']);
  });

  it('reads nothing from no answer', () => {
    expect(readHomeShelfItems(undefined)).toEqual([]);
    expect(readHomeShelfItems({ success: true, schemaVersion: 1 } as unknown as HomeShelfResponse)).toEqual([]);
  });

  it("draws no shelf once fewer than three creations are left, as the server's rule says", () => {
    const member = endpoint.responseVariants.member.response;
    const withoutOne = { ...member, items: member.items.filter((item) => item.id !== 'post-2') };

    expect(readHomeShelfItems(withoutOne)).toEqual([]);
  });
});

describe('homeShelfGuestReturnTo', () => {
  it("brings a guest back to this remix's editor after sign-in, as the web's card does", () => {
    const [video, , motion] = creations;
    const route = (href: string) => {
      const url = new URL(href, 'https://magicbooklet.test');
      return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
    };

    // With the row the creator draws above the prompt, as a signed-in Make
    // this opens it.
    expect(route(homeShelfGuestReturnTo(video))).toEqual({
      pathname: '/create/video',
      params: {
        remix: 'generation-1',
        remixPost: 'post-1',
        sourceTitle: 'Paper boat on a sunlit pond',
        sourceCreator: '@magicbooklet',
        sourceThumbnail: 'https://cdn.example.test/post-1/poster.webp',
      },
    });
    expect(route(homeShelfGuestReturnTo(motion))).toMatchObject({
      pathname: '/create/motion',
      params: { remixPost: 'post-3', sourceTitle: 'Make anyone dance', sourceCreator: '@magicbooklet' },
    });
  });

  it('falls back to the post when the card has no create link it can map', () => {
    const [video] = creations;

    expect(homeShelfGuestReturnTo({ ...video, makeHref: undefined })).toBe('/post/post-1');
    expect(homeShelfGuestReturnTo({ ...video, makeHref: '/somewhere-else' })).toBe('/post/post-1');
  });
});

describe('the shelf says what the web says', () => {
  it('words each offer as the fixture pins', () => {
    const actions = [
      ...endpoint.responseVariants.member.response.items,
      ...endpoint.responseVariants.memberWhoPosted.response.items,
    ].filter((item): item is HomeShelfAction => item.kind === 'action');

    expect(new Set(actions.map((action) => action.id))).toEqual(new Set(['post', 'invite', 'earn']));
    for (const action of actions) {
      const { title, body, cta } = homeShelfActionCopy(action);
      expect({ title, body, cta }).toEqual(endpoint.copy.actions[action.id]);
    }
  });

  it('prices each card as the fixture pins', () => {
    for (const { price, label } of endpoint.copy.prices) {
      expect(formatHomeShelfPrice(price)).toBe(label);
    }
    expect(formatHomeShelfPrice(null)).toBeNull();
  });

  it('badges each card as the fixture pins', () => {
    for (const { badge, fitsWelcomeCredits, offerFreeToTry, label } of endpoint.copy.badges) {
      expect(homeShelfBadge({ badge, fitsWelcomeCredits }, offerFreeToTry)).toBe(label);
    }
  });

  it('states the referral terms to the cent, as the fixture pins', () => {
    for (const { inviterPercent, inviteePercent, body } of endpoint.copy.referralPercents) {
      expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent, inviteePercent }).body).toBe(body);
    }
  });
});

describe('homeShelfActionCopy', () => {
  it('opens the app screen each offer is about', () => {
    expect(homeShelfActionCopy({ kind: 'action', id: 'post' }).route).toBe('/post/new');
    expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 }).route).toBe('/invite');
    expect(homeShelfActionCopy({ kind: 'action', id: 'earn', creatorSharePercent: 85 }).route).toBe('/seller-dashboard');
  });
});

describe('homeShelfCreationLabel', () => {
  it('reads the card in order for a screen reader', () => {
    expect(homeShelfCreationLabel(creations[0])).toBe('Paper boat on a sunlit pond, Grok Imagine, 15 credits, by @magicbooklet');
    expect(homeShelfCreationLabel(creations[2])).toBe('Make anyone dance, Kling 3.0 Motion, Priced by clip length, by @magicbooklet');
  });

  it('reads the badge the card shows, as the web card has it in its link text', () => {
    expect(homeShelfCreationLabel(creations[0], homeShelfBadge(creations[0], true)))
      .toBe('Paper boat on a sunlit pond, Free to try, Grok Imagine, 15 credits, by @magicbooklet');
    expect(homeShelfCreationLabel(creations[2], homeShelfBadge(creations[2], true)))
      .toBe('Make anyone dance, New model, Kling 3.0 Motion, Priced by clip length, by @magicbooklet');
  });

  it('tells a guest that the card opens sign-in first', () => {
    expect(homeShelfCreationHint(true)).toBe('Opens sign-in, then the creator with this prompt and settings');
    expect(homeShelfCreationHint(false)).toBe('Opens the creator with this prompt and settings');
  });
});

describe('homeShelfPosterCacheKey', () => {
  it("shares the feed's cache key for the same media, and falls back to the poster", () => {
    const withKey = {
      ...creations[0],
      post: { ...creations[0].post, mediaItems: [{ ...creations[0].post.mediaItems![0], previewCacheKey: 'media:post-1:preview' }] },
    } as HomeShelfCreation;

    expect(homeShelfPosterCacheKey(withKey)).toBe('media:post-1:preview');
    expect(homeShelfPosterCacheKey(creations[0])).toBe(creations[0].posterUrl);
  });
});

describe('the row', () => {
  it('fits two cards and a sliver of the third', () => {
    const { width } = getHomeShelfCardSize(354, 10);
    expect(2 * width + 10).toBeLessThan(354);
    expect(3 * width + 2 * 10).toBeGreaterThan(354);
  });

  it('grows taller with larger text, up to the cap its text follows', () => {
    const base = getHomeShelfCardSize(354, 10, 1, 1.6);
    const larger = getHomeShelfCardSize(354, 10, 1.4, 1.6);
    const largest = getHomeShelfCardSize(354, 10, 3, 1.6);

    expect(larger.width).toBe(base.width);
    expect(larger.height).toBeGreaterThan(base.height);
    expect(largest.height).toBe(getHomeShelfCardSize(354, 10, 1.6, 1.6).height);
    // Smaller than default text keeps the default height.
    expect(getHomeShelfCardSize(354, 10, 0.8).height).toBe(base.height);
  });

  it('ends on the three creator tools', () => {
    expect(HOME_SHELF_START_BLANK_TOOLS.map((tool) => tool.route)).toEqual(['/create/image', '/create/video', '/create/motion']);
  });

  it('counts renders in progress in words', () => {
    expect(formatActiveRenders(1)).toBe('1 render in progress');
    expect(formatActiveRenders(2)).toBe('2 renders in progress');
  });
});

describe("the shelf's clip in Home's election", () => {
  // The member row: the boat (a clip), the serum (a still), Post, the dance (a clip), Invite.
  const items = endpoint.responseVariants.member.response.items;
  const row = (scrollX: number) => ({ scrollX, viewportWidth: 390, cardWidth: 149, gap: 12, leading: 18 });

  it('plays under an id of its own, never the feed card of the same post', () => {
    expect(homeShelfPlaybackId(creations[0])).toBe('home-shelf:post-1');
    expect(homeShelfPlaybackId(creations[0])).not.toBe(creations[0].post.id);
  });

  it('puts up the first clip card mostly in view, as the feed item it plays under', () => {
    const first = selectHomeShelfPlaybackCandidate(items, row(0));
    expect(first).toMatchObject({ id: 'home-shelf:post-1', mediaKind: 'video', mediaUrl: creations[0].post.mediaUrl });

    // Rested on the Post offer: the boat has gone, the dance is two cards on and in view.
    expect(selectHomeShelfPlaybackCandidate(items, row(2 * 161))?.id).toBe('home-shelf:post-3');
  });

  it('skips a clip card too little in view, and puts up nothing without one', () => {
    // The boat is 45% in view: under the feed's 55%, so the next clip card is looked for and is off screen.
    const almostGone = 18 + 149 * 0.55;
    expect(selectHomeShelfPlaybackCandidate(items, { ...row(almostGone), viewportWidth: 300 })).toBeNull();
    expect(selectHomeShelfPlaybackCandidate(items.filter((item) => item.kind !== 'creation' || !item.clipUrl), row(0))).toBeNull();
    expect(selectHomeShelfPlaybackCandidate(items, { ...row(0), viewportWidth: 0 })).toBeNull();
  });

  it('passes over a clip that failed, for the next clip card in view', () => {
    expect(selectHomeShelfPlaybackCandidate(items, row(0), ['home-shelf:post-1'])).toBeNull();
    expect(selectHomeShelfPlaybackCandidate(items, row(2 * 161), ['home-shelf:post-1'])?.id).toBe('home-shelf:post-3');
    expect(selectHomeShelfPlaybackCandidate(items, row(2 * 161), ['home-shelf:post-3'])).toBeNull();
  });

  it('reads a rest the row can no longer have as its end: a row that lost cards was pulled back', () => {
    // Rested on the dance, then the lineup shrank to the boat alone: the row
    // (the boat and the tools, narrower than the screen) can only be at 0.
    const boatOnly = items.filter((item) => item.id === 'post-1');
    expect(selectHomeShelfPlaybackCandidate(boatOnly, row(3 * 161))?.id).toBe('home-shelf:post-1');
    // The serum and the dance: a rest past the end is the end, where the dance is in view.
    const stillThenDance = items.filter((item) => item.id === 'post-2' || item.id === 'post-3');
    expect(selectHomeShelfPlaybackCandidate(stillThenDance, row(5000))?.id).toBe('home-shelf:post-3');
  });

  it("counts the shelf in view while 55% of it is on screen, as the feed counts a card", () => {
    expect(isHomeShelfInView(100, 270, 844)).toBe(true);
    expect(isHomeShelfInView(-120, 270, 844)).toBe(true);
    expect(isHomeShelfInView(-125, 270, 844)).toBe(false);
    expect(isHomeShelfInView(700, 270, 844)).toBe(false);
    expect(isHomeShelfInView(0, 0, 844)).toBe(false);
  });
});
