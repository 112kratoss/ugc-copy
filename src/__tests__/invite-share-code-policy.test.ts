import { describe, expect, it } from 'vitest';

import { REFERRAL_LINK_DISABLED_CODE as SERVER_CODE } from '@/lib/referral-route-service';
import {
  INVITE_SHARE_CODE_MAX_ACCOUNTS,
  INVITE_SHARE_CODE_RETRY_DELAYS_MS,
  INVITE_SHARE_NO_LINK_RECHECK_MS,
  REFERRAL_LINK_DISABLED_CODE,
  inviteShareCodeRetryAt,
  parseInviteShareCodeStore,
  readInviteShareLinkAnswer,
  shouldRequestInviteShareCode,
  withInviteShareCodeEntry,
} from '../../ugc-mobile/lib/invite-share-link/invite-share-code-policy';

const NOW = Date.parse('2026-11-10T06:00:00.000Z');
const CODE = '30b5f916c7aa';

// One set of rules for holding the sharer's code, on the web and in the app
// (review of 2026-11-10: written twice, a fix had to be made twice).
describe('the rules both clients keep a sharer’s invite code by', () => {
  it('names a switched-off link with the code the server answers', () => {
    expect(SERVER_CODE).toBe(REFERRAL_LINK_DISABLED_CODE);
  });

  it('keeps a code for good, asks about "no link" after a day, and distrusts the future', () => {
    expect(shouldRequestInviteShareCode(null, NOW)).toBe(true);
    expect(shouldRequestInviteShareCode({ code: CODE, readAt: NOW - 400 * 86_400_000 }, NOW)).toBe(false);
    expect(shouldRequestInviteShareCode({ code: null, readAt: NOW - INVITE_SHARE_NO_LINK_RECHECK_MS + 1 }, NOW)).toBe(false);
    expect(shouldRequestInviteShareCode({ code: null, readAt: NOW - INVITE_SHARE_NO_LINK_RECHECK_MS }, NOW)).toBe(true);
    expect(shouldRequestInviteShareCode({ code: CODE, readAt: NOW + 1 }, NOW)).toBe(true);
  });

  it('takes only the server’s "switched off" for "no link"; anything else is asked again', () => {
    expect(readInviteShareLinkAnswer({ ok: true, body: { code: ' 30B5F916C7AA ' } })).toEqual({ kind: 'code', code: CODE });
    expect(readInviteShareLinkAnswer({ ok: true, body: { code: 'nope' } })).toEqual({ kind: 'retry' });
    expect(readInviteShareLinkAnswer({ ok: true, body: null })).toEqual({ kind: 'retry' });
    expect(readInviteShareLinkAnswer({ ok: false, errorCode: REFERRAL_LINK_DISABLED_CODE })).toEqual({ kind: 'none' });
    for (const errorCode of [undefined, 'IDENTITY_CHECK_UNAVAILABLE', 'RATE_LIMITED', 503]) {
      expect(readInviteShareLinkAnswer({ ok: false, errorCode })).toEqual({ kind: 'retry' });
    }
  });

  it('waits longer after each failure, up to its longest wait', () => {
    expect(INVITE_SHARE_CODE_RETRY_DELAYS_MS.map((_, index) => inviteShareCodeRetryAt(index + 1, NOW) - NOW))
      .toEqual([...INVITE_SHARE_CODE_RETRY_DELAYS_MS]);
    expect(inviteShareCodeRetryAt(99, NOW) - NOW).toBe(INVITE_SHARE_CODE_RETRY_DELAYS_MS.at(-1));
    expect(inviteShareCodeRetryAt(0, NOW) - NOW).toBe(INVITE_SHARE_CODE_RETRY_DELAYS_MS[0]);
  });

  it('reads a stored store, dropping anything that is not an answer', () => {
    expect(parseInviteShareCodeStore(JSON.stringify({
      a: { code: CODE, readAt: 1 },
      b: { code: null, readAt: 2 },
      c: { code: 'NOT A CODE', readAt: 3 },
      d: { code: CODE },
      e: 'text',
    }))).toEqual({ a: { code: CODE, readAt: 1 }, b: { code: null, readAt: 2 } });
    for (const raw of [null, '', '{not json', '[]', '42', 'null']) expect(parseInviteShareCodeStore(raw)).toEqual({});
  });

  it('keeps the accounts read most recently, the one being written always among them', () => {
    let store = {};
    for (let index = 0; index < INVITE_SHARE_CODE_MAX_ACCOUNTS + 2; index += 1) {
      store = withInviteShareCodeEntry(store, `user-${index}`, { code: CODE, readAt: NOW + index });
    }
    expect(Object.keys(store).sort()).toEqual(['user-2', 'user-3', 'user-4', 'user-5', 'user-6']);

    // An account read long ago and written again now stays.
    store = withInviteShareCodeEntry(store, 'old-account', { code: CODE, readAt: NOW - 1_000_000 });
    expect(Object.keys(store)).toContain('old-account');
    expect(Object.keys(store)).toHaveLength(INVITE_SHARE_CODE_MAX_ACCOUNTS);
  });
});
