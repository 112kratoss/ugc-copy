import { describe, expect, it } from 'vitest';

import {
  CREATOR_RETURN_NOTE,
  creatorReturnNote,
  hasSameSiteHistory,
  SIGN_IN_WALL_TILE_COUNT,
  signInEmailHref,
  signInHalfAt,
  signInHalfForQuery,
  signInHalfPath,
  signInWallColumnOrder,
} from '@/lib/sign-in-page';

describe('the half the sign-in page shows', () => {
  it('opens on the form for `email=1` and `recovery=1`, else on the choices', () => {
    expect(signInHalfForQuery({})).toBe('choose');
    expect(signInHalfForQuery({ email: '1' })).toBe('email');
    expect(signInHalfForQuery({ recovery: '1' })).toBe('email');
    expect(signInHalfForQuery({ email: 'true', recovery: '0' })).toBe('choose');
  });

  it('reads an address the way Back and Forward land on it', () => {
    expect(signInHalfAt('http://localhost/login?returnUrl=%2Fcreate&email=1')).toBe('email');
    expect(signInHalfAt('/login?returnUrl=%2Fcreate')).toBe('choose');
    expect(signInHalfAt('/login?recovery=1')).toBe('choose');
  });

  it('writes each half’s address from the one it is at, keeping the return and the rest of the query', () => {
    const here = 'http://localhost:3000/login?returnUrl=%2Fcreate-video%3Fhandover%3Dabc12345&mode=signup#top';
    expect(signInHalfPath(here, 'email')).toBe('/login?returnUrl=%2Fcreate-video%3Fhandover%3Dabc12345&mode=signup&email=1#top');
    expect(signInHalfPath(`${here.replace('#top', '')}&email=1&recovery=1`, 'choose'))
      .toBe('/login?returnUrl=%2Fcreate-video%3Fhandover%3Dabc12345&mode=signup');
    // The form's address once: a second turn sets the same flag again.
    expect(signInHalfPath('/login?email=1', 'email')).toBe('/login?email=1');
    expect(signInHalfPath('/login?next=%2Fpricing&recovery=1', 'email')).toBe('/login?next=%2Fpricing&recovery=1&email=1');
  });

  it('links the form as a page of its own for a click before the script runs', () => {
    expect(signInEmailHref('/create-image?handover=abc12345')).toBe('/login?returnUrl=%2Fcreate-image%3Fhandover%3Dabc12345&email=1');
  });
});

describe('the line a creator’s hand-over adds', () => {
  it('is said only when the return carries the hand-over', () => {
    expect(creatorReturnNote('/create-video?handover=nonce-1234')).toBe(CREATOR_RETURN_NOTE);
    expect(creatorReturnNote('/create-image?handover=nonce-1234')).toBe(CREATOR_RETURN_NOTE);
    expect(creatorReturnNote('/create-motion?handover=nonce-1234')).toBe(CREATOR_RETURN_NOTE);
    // A creator reached any other way, or a page that is no creator, keeps no visitor's draft.
    expect(creatorReturnNote('/create-video')).toBeNull();
    expect(creatorReturnNote('/create?handover=nonce-1234')).toBeNull();
    expect(creatorReturnNote('/pricing')).toBeNull();
  });

  it('says the prompt and images stay and nothing runs before Generate', () => {
    expect(CREATOR_RETURN_NOTE).toBe('Your prompt and images stay, and nothing runs until you press Generate.');
  });
});

describe('where Close goes', () => {
  const windowWith = (navigation: unknown, referrer: string, origin = 'https://magicbooklet.com') => ({
    navigation,
    document: { referrer },
    location: { origin },
  }) as unknown as Window;

  it('asks the Navigation API whether this tab has an earlier page of this site', () => {
    expect(hasSameSiteHistory(windowWith({ canGoBack: true }, ''))).toBe(true);
    expect(hasSameSiteHistory(windowWith({ canGoBack: false }, 'https://magicbooklet.com/pricing'))).toBe(false);
  });

  it('without it, takes a referrer of this site as one', () => {
    expect(hasSameSiteHistory(windowWith(undefined, 'https://magicbooklet.com/pricing'))).toBe(true);
    expect(hasSameSiteHistory(windowWith(undefined, 'https://www.google.com/'))).toBe(false);
    expect(hasSameSiteHistory(windowWith(undefined, ''))).toBe(false);
    expect(hasSameSiteHistory(windowWith(undefined, 'not a url'))).toBe(false);
  });
});

describe('the wall’s columns', () => {
  it('take the app’s order: six of the twelve each, never a picture twice', () => {
    expect(signInWallColumnOrder(0)).toEqual([0, 4, 8, 2, 6, 10]);
    expect(signInWallColumnOrder(1)).toEqual([1, 5, 9, 3, 7, 11]);
    for (let column = 0; column < 11; column += 1) {
      const order = signInWallColumnOrder(column);
      expect(new Set(order).size).toBe(6);
      expect(order.every((index) => index >= 0 && index < SIGN_IN_WALL_TILE_COUNT)).toBe(true);
    }
  });

  it('never put one picture in two neighbouring columns', () => {
    for (let column = 0; column < 10; column += 1) {
      const next = new Set(signInWallColumnOrder(column + 1));
      expect(signInWallColumnOrder(column).filter((index) => next.has(index))).toEqual([]);
    }
  });
});

describe('the wall’s start for a visit', () => {
  it('is a point along the loop, from 0 up to 1', async () => {
    const { pickSignInWallStart } = await import('@/lib/sign-in-page-server');
    const starts = Array.from({ length: 50 }, () => pickSignInWallStart());
    expect(starts.every((start) => start >= 0 && start < 1)).toBe(true);
    expect(new Set(starts).size).toBeGreaterThan(1);
  });
});
