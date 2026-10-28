import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UnlockDetailPage from '@/app/unlocks/[postId]/page';

const redirectMock = vi.hoisted(() => vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
}));
const getServerAuthStateMock = vi.hoisted(() => vi.fn());
const getViewerUnlockDetailMock = vi.hoisted(() => vi.fn());
const getViewerUnlockRemovalMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<'moderation' | null>>(async () => null));
const unlockDetailProps = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  redirect: (target: string) => redirectMock(target),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/viewer-unlock-detail', () => ({
  getViewerUnlockDetail: (input: unknown) => getViewerUnlockDetailMock(input),
  getViewerUnlockRemoval: (input: unknown) => getViewerUnlockRemovalMock(input),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/app/unlocks/[postId]/UnlockDetail', () => ({
  default: (props: unknown) => {
    unlockDetailProps(props);
    return null;
  },
}));

const UNLOCK_ID = '11111111-1111-4111-8111-111111111111';

// `postReachable` is the server's word on whether the post page would open for
// this buyer: public or unlisted, live, and no block either way.
const reachablePostDetail = {
  unlockId: UNLOCK_ID,
  creatorUserId: 'creator-1',
  isNsfw: false,
  postReachable: true,
  post: {
    id: 'post-1',
    visibility: 'public',
    archivedAt: null,
    tombstoned: false,
  },
};

function openUnlock(unlockId = UNLOCK_ID) {
  return UnlockDetailPage({ params: Promise.resolve({ postId: unlockId }) });
}

describe('UnlockDetailPage', () => {
  beforeEach(() => {
    redirectMock.mockClear();
    getViewerUnlockDetailMock.mockReset();
    unlockDetailProps.mockClear();
    getServerAuthStateMock.mockResolvedValue({ session: { user: { id: 'buyer-1' } } });
    getViewerUnlockDetailMock.mockResolvedValue(reachablePostDetail);
  });

  it('sends a buyer on to the post page when it would open for them, with the way back to their library', async () => {
    await expect(openUnlock())
      .rejects.toThrow('NEXT_REDIRECT:/showcase/post-1?from=library&returnTo=%2Fcreations%3Fview%3Dunlocks#recipe');

    expect(getViewerUnlockDetailMock).toHaveBeenCalledWith({
      adminSupabase: { service: true },
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });
    expect(unlockDetailProps).not.toHaveBeenCalled();
  });

  it('keeps the unlock page when the post is out of reach, as across a block, where the post page would answer not-found', async () => {
    const blockedDetail = { ...reachablePostDetail, postReachable: false };
    getViewerUnlockDetailMock.mockResolvedValueOnce(blockedDetail);

    render(await openUnlock());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(unlockDetailProps).toHaveBeenCalledWith({ detail: blockedDetail });
  });

  it('keeps a mature purchase on the unlock page even when its post is reachable', async () => {
    // The post page's gate asks for the mature-content preference, which a
    // buyer need not have; the purchase is their entitlement.
    const matureDetail = { ...reachablePostDetail, isNsfw: true };
    getViewerUnlockDetailMock.mockResolvedValueOnce(matureDetail);

    render(await openUnlock());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(unlockDetailProps).toHaveBeenCalledWith({ detail: matureDetail });
  });

  it('keeps the unlock page for a deleted post', async () => {
    const tombstonedDetail = {
      ...reachablePostDetail,
      postReachable: false,
      post: { ...reachablePostDetail.post, tombstoned: true },
    };
    getViewerUnlockDetailMock.mockResolvedValueOnce(tombstonedDetail);

    render(await openUnlock());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(unlockDetailProps).toHaveBeenCalledWith({ detail: tombstonedDetail });
  });

  // D2 (2026-10-27): a take-down made the purchase vanish without a word,
  // the link landing on the library as if nothing had happened (B-F12).
  it('says a recipe removed by moderation was removed, where it used to send the buyer away', async () => {
    getViewerUnlockDetailMock.mockResolvedValue(null);
    getViewerUnlockRemovalMock.mockResolvedValueOnce('moderation');

    render(await openUnlock());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByText('This recipe was removed for breaking the community rules.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlocked recipes' })).toHaveAttribute('href', '/creations?view=unlocks');
    expect(getViewerUnlockRemovalMock).toHaveBeenCalledWith(expect.objectContaining({ unlockId: UNLOCK_ID, viewerUserId: 'buyer-1' }));
  });

  it('sends an unlock this buyer does not hold back to the library', async () => {
    getViewerUnlockDetailMock.mockResolvedValueOnce(null);

    await expect(openUnlock()).rejects.toThrow('NEXT_REDIRECT:/creations?view=unlocks');
    expect(unlockDetailProps).not.toHaveBeenCalled();
  });

  it('sends a malformed unlock id back to the library, not to an error page, without asking the database', async () => {
    // The real loader: the service client stub has no rpc, so a database call
    // would throw instead of redirecting.
    const { getViewerUnlockDetail } = await vi.importActual<typeof import('@/lib/viewer-unlock-detail')>(
      '@/lib/viewer-unlock-detail',
    );
    getViewerUnlockDetailMock.mockImplementationOnce(getViewerUnlockDetail);

    await expect(openUnlock('not-an-unlock')).rejects.toThrow('NEXT_REDIRECT:/creations?view=unlocks');
    expect(unlockDetailProps).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in', async () => {
    getServerAuthStateMock.mockResolvedValueOnce({ session: null });

    await expect(openUnlock('unlock-1'))
      .rejects.toThrow('NEXT_REDIRECT:/login?returnUrl=/unlocks/unlock-1');
    expect(getViewerUnlockDetailMock).not.toHaveBeenCalled();
  });
});
