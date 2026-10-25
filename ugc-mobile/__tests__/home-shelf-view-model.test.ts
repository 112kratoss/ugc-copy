import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  HOME_SHELF_START_BLANK_TOOLS,
  formatHomeShelfPrice,
  getHomeShelfCardWidth,
  homeShelfActionCopy,
  homeShelfBadge,
  homeShelfCreationLabel,
  readHomeShelfItems,
} from '../lib/home-shelf-view-model';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem, HomeShelfPrice, HomeShelfResponse } from '../lib/types';

const endpoint = mobileApiContract.endpoints.getHomeShelf as unknown as {
  response: HomeShelfResponse;
  responseVariants: Record<'member' | 'memberWhoPosted', { response: HomeShelfResponse }>;
  copy: {
    actions: Record<HomeShelfAction['id'], { title: string; body: string; cta: string }>;
    prices: Array<{ price: HomeShelfPrice; label: string }>;
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
});

describe('homeShelfActionCopy', () => {
  it('opens the app screen each offer is about', () => {
    expect(homeShelfActionCopy({ kind: 'action', id: 'post' }).route).toBe('/post/new');
    expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 }).route).toBe('/invite');
    expect(homeShelfActionCopy({ kind: 'action', id: 'earn', creatorSharePercent: 85 }).route).toBe('/seller-dashboard');
  });

  it('leaves out a referral side that earns nothing', () => {
    expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent: 2.5, inviteePercent: 0 }).body)
      .toBe('You get 2.5% of their top-ups in credits.');
  });
});

describe('homeShelfBadge', () => {
  it('puts a launch before the welcome credits', () => {
    expect(homeShelfBadge({ ...creations[0], badge: 'new-model' }, true)).toBe('New model');
  });

  it('says "Free to try" only to someone still owed the welcome credits', () => {
    expect(homeShelfBadge(creations[0], true)).toBe('Free to try');
    expect(homeShelfBadge(creations[0], false)).toBeNull();
    expect(homeShelfBadge({ ...creations[0], fitsWelcomeCredits: false }, true)).toBeNull();
  });
});

describe('homeShelfCreationLabel', () => {
  it('reads the card in order for a screen reader', () => {
    expect(homeShelfCreationLabel(creations[0])).toBe('Paper boat on a sunlit pond, Grok Imagine, 15 credits, by @magicbooklet');
    expect(homeShelfCreationLabel(creations[2])).toBe('Make anyone dance, Kling 3.0 Motion, Priced by clip length, by @magicbooklet');
  });
});

describe('the row', () => {
  it('fits two cards and a sliver of the third', () => {
    const width = getHomeShelfCardWidth(354, 10);
    expect(2 * width + 10).toBeLessThan(354);
    expect(3 * width + 2 * 10).toBeGreaterThan(354);
  });

  it('ends on the three creator tools', () => {
    expect(HOME_SHELF_START_BLANK_TOOLS.map((tool) => tool.route)).toEqual(['/create/image', '/create/video', '/create/motion']);
  });
});
