import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS,
  APPLE_WEB_RETURN_PATH,
  buildAppleWebAuthorizationUrl,
  forgetAppleWebAuthorizationStart,
  getAppleWebAuthorization,
  getAppleWebClientId,
  getAppleWebReturnUrl,
  judgeAppleWebAuthorizationAnswer,
  readAppleWebAuthorizationAnswer,
  readAppleWebAuthorizationStart,
  rememberAppleWebAuthorizationStart,
} from '@/lib/apple-web-reauthentication';
import { siteConfig } from '@/lib/seo';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('Continue with Apple on the website', () => {
  // Apple answers in the fragment only without a scope, and the deletion needs no name or email.
  it("asks Apple's authorize page for a code alone, answered in the fragment back to the deletion page", () => {
    const url = new URL(buildAppleWebAuthorizationUrl({
      clientId: 'com.magicbooklet.mobile.web',
      returnUrl: 'https://magicbooklet.com/delete-account',
      state: 'state-1',
    }));

    expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'com.magicbooklet.mobile.web',
      redirect_uri: 'https://magicbooklet.com/delete-account',
      response_type: 'code',
      response_mode: 'fragment',
      state: 'state-1',
    });
  });

  it("returns to the deletion page on the site's own origin", () => {
    expect(APPLE_WEB_RETURN_PATH).toBe('/delete-account');
    expect(getAppleWebReturnUrl('https://magicbooklet.com')).toBe('https://magicbooklet.com/delete-account');
    expect(getAppleWebReturnUrl('https://magicbooklet.com/')).toBe('https://magicbooklet.com/delete-account');
  });

  it("reads Apple's code or its refusal, each with the state it came back with", () => {
    expect(readAppleWebAuthorizationAnswer('#code=c.1-x&state=state-1')).toEqual({ code: 'c.1-x', state: 'state-1' });
    expect(readAppleWebAuthorizationAnswer('state=state-1&code=c')).toEqual({ code: 'c', state: 'state-1' });
    expect(readAppleWebAuthorizationAnswer('#error=user_cancelled_authorize&state=state-1')).toEqual({
      error: 'user_cancelled_authorize',
      state: 'state-1',
    });
  });

  it('finds no answer in a fragment without a state, or with neither a code nor an error', () => {
    expect(readAppleWebAuthorizationAnswer('')).toBeNull();
    expect(readAppleWebAuthorizationAnswer('#')).toBeNull();
    expect(readAppleWebAuthorizationAnswer('#code=c')).toBeNull();
    expect(readAppleWebAuthorizationAnswer('#state=state-1')).toBeNull();
    expect(readAppleWebAuthorizationAnswer('#section-2')).toBeNull();
  });

  it('takes the Services ID from the environment, and none from a blank value', () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SERVICES_ID', ' com.magicbooklet.mobile.web ');
    expect(getAppleWebClientId()).toBe('com.magicbooklet.mobile.web');

    vi.stubEnv('NEXT_PUBLIC_APPLE_SERVICES_ID', '  ');
    expect(getAppleWebClientId()).toBeNull();
  });

  // Apple returns only to the registered address, so another origin of the site cannot run it.
  it("runs only with a Services ID, and returns only to the site's own origin", () => {
    const siteOrigin = new URL(siteConfig.siteUrl).origin;
    expect(getAppleWebAuthorization(siteOrigin)).toBeNull();

    vi.stubEnv('NEXT_PUBLIC_APPLE_SERVICES_ID', 'com.magicbooklet.mobile.web');
    expect(getAppleWebAuthorization(siteOrigin)).toEqual({
      clientId: 'com.magicbooklet.mobile.web',
      returnUrl: `${siteOrigin}/delete-account`,
      returnsHere: true,
    });
    expect(getAppleWebAuthorization('https://preview.example.vercel.app')).toMatchObject({ returnsHere: false });
  });

  describe("the start a tab keeps for Apple's answer", () => {
    it('keeps one start, reads it back, and forgets it', () => {
      expect(readAppleWebAuthorizationStart()).toBeNull();
      expect(rememberAppleWebAuthorizationStart({ state: 'state-1', userId: 'user-1' })).toBe(true);
      expect(readAppleWebAuthorizationStart()).toEqual({ state: 'state-1', userId: 'user-1' });

      forgetAppleWebAuthorizationStart();
      expect(readAppleWebAuthorizationStart()).toBeNull();
    });

    // Long enough for a person who takes their time on Apple's page, or goes Back to it and
    // confirms again; a start from longer ago answers nothing.
    it('answers Apple for ten minutes from the press', () => {
      const pressedAt = Date.UTC(2026, 10, 3, 10, 0, 0);
      rememberAppleWebAuthorizationStart({ state: 'state-1', userId: 'user-1' }, pressedAt);

      expect(APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS).toBe(10 * 60 * 1000);
      expect(readAppleWebAuthorizationStart(pressedAt + APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS))
        .toEqual({ state: 'state-1', userId: 'user-1' });
      expect(readAppleWebAuthorizationStart(pressedAt + APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS + 1)).toBeNull();
      // A clock since set back says nothing of the start's age.
      expect(readAppleWebAuthorizationStart(pressedAt - 1)).toBeNull();
    });

    it('reads no start from a value it did not write, and says when the browser keeps none', () => {
      window.sessionStorage.setItem('magicbooklet:apple-account-deletion', '{"state":"state-1"}');
      expect(readAppleWebAuthorizationStart()).toBeNull();
      // One kept before starts had an age.
      window.sessionStorage.setItem('magicbooklet:apple-account-deletion', '{"state":"state-1","userId":"user-1"}');
      expect(readAppleWebAuthorizationStart()).toBeNull();
      window.sessionStorage.setItem('magicbooklet:apple-account-deletion', 'not json');
      expect(readAppleWebAuthorizationStart()).toBeNull();

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Storage is disabled', 'SecurityError');
      });
      expect(rememberAppleWebAuthorizationStart({ state: 'state-2', userId: 'user-1' })).toBe(false);
    });
  });

  // A link to Apple's page from anywhere else comes back to the page with a code too.
  it("uses Apple's code only for the start this tab kept, for the account that started it", () => {
    const start = { state: 'state-1', userId: 'user-1' };
    const code = { code: 'apple-code', state: 'state-1' };

    expect(judgeAppleWebAuthorizationAnswer(null, start, 'user-1')).toBeNull();
    expect(judgeAppleWebAuthorizationAnswer(code, start, 'user-1')).toEqual({ code: 'apple-code' });
    expect(judgeAppleWebAuthorizationAnswer(code, null, 'user-1')).toEqual({ refusal: 'elsewhere' });
    expect(judgeAppleWebAuthorizationAnswer({ ...code, state: 'state-2' }, start, 'user-1')).toEqual({ refusal: 'elsewhere' });
    expect(judgeAppleWebAuthorizationAnswer(code, start, 'user-2')).toEqual({ refusal: 'elsewhere' });
    expect(judgeAppleWebAuthorizationAnswer(code, start, null)).toEqual({ refusal: 'elsewhere' });
    expect(judgeAppleWebAuthorizationAnswer({ error: 'user_cancelled_authorize', state: 'state-1' }, start, 'user-1'))
      .toEqual({ refusal: 'cancelled' });
    expect(judgeAppleWebAuthorizationAnswer({ error: 'server_error', state: 'state-1' }, start, 'user-1'))
      .toEqual({ refusal: 'not-confirmed' });
  });
});
