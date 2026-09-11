import { describe, expect, it } from 'vitest';

import {
  GUEST_SESSION_MERGED,
  SESSION_ENDED_ELSEWHERE,
  authNoticeForRedirect,
} from '../lib/auth-error-copy';

describe('notices a redirect to the sign-in screen can carry', () => {
  it('explains a session that ended somewhere else', () => {
    expect(authNoticeForRedirect('signed-out')).toBe(SESSION_ENDED_ELSEWHERE);
    // It explains a redirect; nothing failed on this device.
    expect(SESSION_ENDED_ELSEWHERE.tone).toBe('info');
  });

  it('still explains a guest session that was merged into an account', () => {
    expect(authNoticeForRedirect('session-merged')).toBe(GUEST_SESSION_MERGED);
  });

  it('reads the first value when the route repeats the parameter', () => {
    expect(authNoticeForRedirect(['signed-out', 'session-merged'])).toBe(SESSION_ENDED_ELSEWHERE);
  });

  it('shows nothing for an unknown key, so a deep link cannot put its own text on the screen', () => {
    expect(authNoticeForRedirect('anything-else')).toBeNull();
    expect(authNoticeForRedirect(undefined)).toBeNull();
    expect(authNoticeForRedirect([])).toBeNull();
  });
});
