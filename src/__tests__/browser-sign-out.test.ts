import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accessTokenSessionId,
  forgetBrowserSignOut,
  markBrowserSignOut,
  wasSignedOutInBrowser,
} from '@/lib/browser-sign-out';

/** A token as Supabase signs one: base64url segments, its payload naming the session. */
function tokenFor(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

const sessionOf = (userId: string, sessionId: string | null) => ({
  access_token: sessionId === null ? 'opaque-token' : tokenFor({ sub: userId, session_id: sessionId }),
  user: { id: userId },
});

describe('a sign-out made in this browser', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads the session a token belongs to, base64url characters included', () => {
    // '?>?' encodes to '-' and '_' in base64url, which plain base64 writes as '+' and '/'.
    expect(accessTokenSessionId(tokenFor({ session_id: 'session-1', note: '?>?>?>' }))).toBe('session-1');
    expect(accessTokenSessionId(tokenFor({ sub: 'user-1' }))).toBeNull();
    expect(accessTokenSessionId('not-a-token')).toBeNull();
    expect(accessTokenSessionId('a.%%%.b')).toBeNull();
  });

  it('ended the session it marked, and no other session or account', () => {
    markBrowserSignOut(sessionOf('user-1', 'session-1'));

    expect(wasSignedOutInBrowser(sessionOf('user-1', 'session-1'))).toBe(true);
    expect(wasSignedOutInBrowser(sessionOf('user-1', 'session-2'))).toBe(false);
    expect(wasSignedOutInBrowser(sessionOf('user-2', 'session-1'))).toBe(false);
    expect(wasSignedOutInBrowser(sessionOf('user-1', null))).toBe(false);
  });

  it('matches by account only where neither token names a session', () => {
    markBrowserSignOut(sessionOf('user-1', null));

    expect(wasSignedOutInBrowser(sessionOf('user-1', null))).toBe(true);
    expect(wasSignedOutInBrowser(sessionOf('user-1', 'session-1'))).toBe(false);
  });

  it('is taken back by a sign-out that failed', () => {
    markBrowserSignOut(sessionOf('user-1', 'session-1'));
    forgetBrowserSignOut();

    expect(wasSignedOutInBrowser(sessionOf('user-1', 'session-1'))).toBe(false);
  });

  it('reads as no sign-out where the browser refuses its storage', () => {
    markBrowserSignOut(sessionOf('user-1', 'session-1'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(wasSignedOutInBrowser(sessionOf('user-1', 'session-1'))).toBe(false);
  });
});
