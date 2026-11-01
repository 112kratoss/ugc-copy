import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accessTokenSessionId,
  BROWSER_SIGN_OUT_KEY,
  browserSignOutSnapshot,
  forgetBrowserSignOut,
  markBrowserSignOut,
  subscribeToBrowserSignOuts,
  wasSessionSignedOutInBrowser,
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
    expect(wasSessionSignedOutInBrowser('session-1')).toBe(true);
    expect(wasSessionSignedOutInBrowser(null)).toBe(false);
  });

  it('marks nothing for a token that names no session', () => {
    markBrowserSignOut('opaque-token', undefined, null);

    expect(browserSignOutSnapshot()).toBeNull();
  });

  // A tab that hears of its session's end late, after other sign-outs, still finds its own.
  it('keeps the marks of earlier sign-outs, up to the last ten', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    markBrowserSignOut(tokenOf('user-2', 'session-2'), tokenOf('user-2', 'session-3'));

    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(true);
    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-2'))).toBe(true);
    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-3'))).toBe(true);

    for (let index = 4; index <= 12; index += 1) markBrowserSignOut(tokenOf('user-3', `session-${index}`));
    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(false);
    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-2'))).toBe(false);
    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-3'))).toBe(true);
    expect(wasSignedOutInBrowser(tokenOf('user-3', 'session-12'))).toBe(true);
  });

  it('takes back only the marks of a sign-out that failed', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    markBrowserSignOut(tokenOf('user-2', 'session-2'));
    forgetBrowserSignOut(tokenOf('user-2', 'session-2'), undefined);

    expect(wasSignedOutInBrowser(tokenOf('user-2', 'session-2'))).toBe(false);
    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(true);

    forgetBrowserSignOut(tokenOf('user-1', 'session-1'));
    expect(browserSignOutSnapshot()).toBeNull();
  });

  it('reads the marks of a snapshot given, the stored ones otherwise', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    const snapshot = browserSignOutSnapshot();
    window.localStorage.clear();

    expect(wasSessionSignedOutInBrowser('session-1', snapshot)).toBe(true);
    expect(wasSessionSignedOutInBrowser('session-1')).toBe(false);
    expect(wasSessionSignedOutInBrowser('session-1', 'not json')).toBe(false);
  });

  it('calls back when another tab writes the marks, and for nothing else', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToBrowserSignOuts(onChange);

    window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_SIGN_OUT_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'another-key' }));
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_SIGN_OUT_KEY }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads as no sign-out where the browser refuses its storage', () => {
    markBrowserSignOut(tokenOf('user-1', 'session-1'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(wasSignedOutInBrowser(tokenOf('user-1', 'session-1'))).toBe(false);
    expect(() => markBrowserSignOut(tokenOf('user-1', 'session-2'))).not.toThrow();
  });
});
