import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVITE_SHARE_CODE_STORAGE_KEY,
  forgetInviteShareCode,
  holdStoredInviteShareCode,
  resetInviteShareCodeForTests,
} from '@/lib/invite-share-code';
import { shareCreatorProfile, sharePublicGeneration, withSharersInvite } from '@/lib/share-client';

const USER = 'user-1';
const CODE = '30b5f916c7aa';
const ORIGIN = window.location.origin;

const SESSION_COOKIE = 'sb-example-auth-token';

/** The browser's Supabase session cookie, as @supabase/ssr writes it, for `userId`. */
function signInCookie(userId: string) {
  const session = JSON.stringify({ access_token: 'token', user: { id: userId } });
  document.cookie = `${SESSION_COOKIE}=base64-${Buffer.from(session).toString('base64url')}; path=/`;
}

function signOutCookie() {
  document.cookie = `${SESSION_COOKIE}=; Max-Age=0; path=/`;
}

/** The account signed in to this browser has its invite code at hand. */
function signedInWithCode() {
  window.localStorage.setItem(
    INVITE_SHARE_CODE_STORAGE_KEY,
    JSON.stringify({ [USER]: { code: CODE, readAt: Date.now() } }),
  );
  signInCookie(USER);
  holdStoredInviteShareCode(USER);
}

// Every link a signed-in account sends out of the product carries its invite,
// so a visitor it brings who signs up counts as that account's referral. A
// guest's and a visitor's links carry none.
describe('links shared from the web', () => {
  const share = vi.fn(async (_data: ShareData) => undefined);
  const writeText = vi.fn(async (_text: string) => undefined);

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    resetInviteShareCodeForTests();
    window.localStorage.clear();
    signOutCookie();
    share.mockClear();
    writeText.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    signOutCookie();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shares a post with the surface it came from and the sharer’s invite', async () => {
    signedInWithCode();

    await expect(sharePublicGeneration({
      generationId: 'post-1', title: 'Shared creation', sourceSurface: 'showcase-reel', accessToken: 'token',
    })).resolves.toBe('native-share');

    expect(share.mock.calls[0][0].url).toBe(`${ORIGIN}/showcase/post-1?s=showcase-reel&r=${CODE}`);
  });

  // A sign-out on a page with no auth provider, or another account signing in
  // there, never reached the holder, and the next share in that tab carried the
  // last account's code (review of 2026-11-10). The share reads the cookie.
  it('carries no code once the browser signed out or someone else signed in, wherever it happened', async () => {
    signedInWithCode();
    signOutCookie();
    expect(withSharersInvite(`${ORIGIN}/showcase/post-1?s=feed`)).toBe(`${ORIGIN}/showcase/post-1?s=feed`);

    signedInWithCode();
    signInCookie('someone-else');
    expect(withSharersInvite(`${ORIGIN}/showcase/post-1?s=feed`)).toBe(`${ORIGIN}/showcase/post-1?s=feed`);

    // The same account's cookie, refreshed: still its code.
    signedInWithCode();
    signInCookie(USER);
    expect(withSharersInvite(`${ORIGIN}/showcase/post-1?s=feed`)).toBe(`${ORIGIN}/showcase/post-1?s=feed&r=${CODE}`);
  });

  it('copies a post link with the invite where the browser cannot share', async () => {
    signedInWithCode();
    Reflect.deleteProperty(navigator, 'share');

    await expect(sharePublicGeneration({
      generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed', accessToken: 'token',
    })).resolves.toBe('copy-link');

    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/showcase/post-1?s=feed&r=${CODE}`);
  });

  it('shares a creator profile with the sharer’s invite', async () => {
    signedInWithCode();

    await shareCreatorProfile({
      username: 'creator-name', displayName: 'Creator Name', sourceSurface: 'creator-profile', accessToken: 'token',
    });

    expect(share.mock.calls[0][0].url).toBe(`${ORIGIN}/creators/creator-name?s=creator-profile&r=${CODE}`);
  });

  it('sends a visitor’s and a guest’s links out with no invite', async () => {
    await sharePublicGeneration({ generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed' });
    await shareCreatorProfile({ username: 'creator-name', displayName: 'Creator Name', sourceSurface: 'creator-profile' });

    expect(share.mock.calls.map(([data]) => data.url)).toEqual([
      `${ORIGIN}/showcase/post-1?s=feed`,
      `${ORIGIN}/creators/creator-name?s=creator-profile`,
    ]);
  });

  it('stops carrying the invite the moment the account signs out', async () => {
    signedInWithCode();
    forgetInviteShareCode();

    await sharePublicGeneration({ generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed' });

    expect(share.mock.calls[0][0].url).toBe(`${ORIGIN}/showcase/post-1?s=feed`);
  });

  it('puts the invite on a link copied by hand too, before its fragment', () => {
    signedInWithCode();

    expect(withSharersInvite(`${ORIGIN}/showcase/post-1?s=my-creations#recipe`))
      .toBe(`${ORIGIN}/showcase/post-1?s=my-creations&r=${CODE}#recipe`);
  });

  it('reads the code as the share is made, never before', async () => {
    // The share's own click is the only moment the browser allows it, so the
    // code is not awaited: one that arrives a moment later rides the next share.
    await sharePublicGeneration({ generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed' });
    signedInWithCode();
    await sharePublicGeneration({ generationId: 'post-1', title: 'Shared creation', sourceSurface: 'feed' });

    expect(share.mock.calls.map(([data]) => data.url)).toEqual([
      `${ORIGIN}/showcase/post-1?s=feed`,
      `${ORIGIN}/showcase/post-1?s=feed&r=${CODE}`,
    ]);
  });
});
