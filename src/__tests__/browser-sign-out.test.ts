import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accessTokenSessionId,
  forgetBrowserSignOut,
  markBrowserSignOut,
  wasSignedOutInBrowser,
} from '@/lib/browser-sign-out';
import { unsignedJwt } from '@/__tests__/fixtures/unsigned-jwt';

const tokenOf = (userId: string, sessionId: string) => unsignedJwt({ sub: userId, session_id: sessionId });

describe('a sign-out made in this browser', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads the session a token belongs to, base64url characters included', () => {
    // '?>?' encodes to '-' and '_' in base64url, which plain base64 writes as '+' and '/'.
    expect(accessTokenSessionId(unsignedJwt({ session_id: 'session-1', note: '?>?>?>' }))).toBe('session-1');
    expect(accessTokenSessionId(unsignedJwt({ sub: 'user-1' }))).toBeNull();
    expect(accessTokenSessionId('not-a-token')).toBeNull();
    expect(accessTokenSessionId('a.%%%.b')).toBeNull();
    expect(accessTokenSessionId(undefined)).toBeNull();
  });

  it('ended the session it marked, and no other session', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));

    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(true);
    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-2'))).toBe(false);
    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-2'))).toBe(false);
    expect(wasSignedOutInBrowser('opaque-token')).toBe(false);
    expect(wasSignedOutInBrowser(undefined)).toBe(false);
  });

  it('marks nothing for a token that names no session', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    markBrowserSignOut('opaque-token');
    markBrowserSignOut(undefined);

    // The earlier mark stands: nothing took its place.
    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(true);
  });

  it('is taken back by a sign-out that failed', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    forgetBrowserSignOut();

    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(false);
  });

  it('reads as no sign-out where the browser refuses its storage', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(false);
  });
});
