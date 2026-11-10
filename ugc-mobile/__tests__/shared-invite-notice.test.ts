import { describe, expect, it, vi } from 'vitest';

const pending = vi.hoisted(() => ({ current: null as unknown, fail: false }));
vi.mock('../lib/referral-attribution', () => ({
  getPendingReferral: vi.fn(async () => {
    if (pending.fail) throw new Error('keychain locked');
    return pending.current;
  }),
}));

import { INVITE_SHARE_DISCLOSURE } from '../lib/invite-share-link/invite-share-link';
import { SHARED_INVITE_NOTICE, readSharedInviteNotice } from '../lib/shared-invite-notice';

// Someone whose invite a shared post left on the phone is told, before joining,
// that the person who shared it may earn from it (re-review of 2026-11-10).
describe('the sign-in page’s notice for an invite a shared link left', () => {
  it('names the disclosure for a shared link’s invite, and nothing else', async () => {
    pending.current = { code: '30b5f916c7aa', capturedAt: '2026-11-10T00:00:00.000Z', kind: 'shared_link' };
    await expect(readSharedInviteNotice()).resolves.toEqual(SHARED_INVITE_NOTICE);
    expect(SHARED_INVITE_NOTICE).toMatchObject({ tone: 'info', body: INVITE_SHARE_DISCLOSURE });

    // An invite link's own landing already said who invited them.
    pending.current = { code: '30b5f916c7aa', capturedAt: '2026-11-10T00:00:00.000Z', kind: 'invite' };
    await expect(readSharedInviteNotice()).resolves.toBeNull();
    pending.current = { code: '30b5f916c7aa', capturedAt: '2026-11-10T00:00:00.000Z' };
    await expect(readSharedInviteNotice()).resolves.toBeNull();
    pending.current = null;
    await expect(readSharedInviteNotice()).resolves.toBeNull();
  });

  it('says nothing when the phone cannot be read', async () => {
    pending.fail = true;
    await expect(readSharedInviteNotice()).resolves.toBeNull();
    pending.fail = false;
  });
});
