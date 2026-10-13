import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UnlockDetailPage from '@/app/unlocks/[postId]/page';

const redirectMock = vi.hoisted(() => vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
}));
const getServerAuthStateMock = vi.hoisted(() => vi.fn());
const getViewerUnlockDetailMock = vi.hoisted(() => vi.fn());
const isUserRelationshipBlockedMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<boolean>>());
const logBackendErrorMock = vi.hoisted(() => vi.fn());
const unlockDetailProps = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  redirect: (target: string) => redirectMock(target),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/viewer-unlock-detail', () => ({
  getViewerUnlockDetail: (input: unknown) => getViewerUnlockDetailMock(input),
}));

vi.mock('@/lib/moderation-service', () => ({
  isUserRelationshipBlocked: (input: unknown) => isUserRelationshipBlockedMock(input),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => logBackendErrorMock(...args),
}));

vi.mock('@/app/unlocks/[postId]/UnlockDetail', () => ({
  default: (props: unknown) => {
    unlockDetailProps(props);
    return null;
  },
}));

const publicPostDetail = {
  unlockId: 'unlock-1',
  creatorUserId: 'creator-1',
  post: {
    id: 'post-1',
    visibility: 'public',
    archivedAt: null,
    tombstoned: false,
  },
};

describe('UnlockDetailPage', () => {
  beforeEach(() => {
    redirectMock.mockClear();
    getViewerUnlockDetailMock.mockReset();
    isUserRelationshipBlockedMock.mockReset();
    logBackendErrorMock.mockClear();
    unlockDetailProps.mockClear();
    getServerAuthStateMock.mockResolvedValue({ session: { user: { id: 'buyer-1' } } });
    getViewerUnlockDetailMock.mockResolvedValue(publicPostDetail);
  });

  it('sends a buyer of a publicly readable post to the post page', async () => {
    isUserRelationshipBlockedMock.mockResolvedValueOnce(false);

    await expect(UnlockDetailPage({ params: Promise.resolve({ postId: 'unlock-1' }) }))
      .rejects.toThrow('NEXT_REDIRECT:/showcase/post-1');

    expect(isUserRelationshipBlockedMock).toHaveBeenCalledWith({
      adminSupabase: { service: true },
      firstUserId: 'buyer-1',
      secondUserId: 'creator-1',
    });
    expect(unlockDetailProps).not.toHaveBeenCalled();
  });

  it('keeps the unlock page across a block, where the post page would answer not-found', async () => {
    isUserRelationshipBlockedMock.mockResolvedValueOnce(true);

    render(await UnlockDetailPage({ params: Promise.resolve({ postId: 'unlock-1' }) }));

    expect(redirectMock).not.toHaveBeenCalled();
    expect(unlockDetailProps).toHaveBeenCalledWith({ detail: publicPostDetail });
  });

  it('treats a block it could not check as a block and shows the unlock page', async () => {
    isUserRelationshipBlockedMock.mockRejectedValueOnce(new Error('connection reset'));

    render(await UnlockDetailPage({ params: Promise.resolve({ postId: 'unlock-1' }) }));

    expect(redirectMock).not.toHaveBeenCalled();
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_verify_block_state_for_unlock_page',
      { error: expect.any(Error) },
    );
    expect(unlockDetailProps).toHaveBeenCalledWith({ detail: publicPostDetail });
  });

  it('asks no block question when the post is not publicly readable', async () => {
    getViewerUnlockDetailMock.mockResolvedValueOnce({
      ...publicPostDetail,
      post: { ...publicPostDetail.post, tombstoned: true },
    });

    render(await UnlockDetailPage({ params: Promise.resolve({ postId: 'unlock-1' }) }));

    expect(isUserRelationshipBlockedMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(unlockDetailProps).toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in', async () => {
    getServerAuthStateMock.mockResolvedValueOnce({ session: null });

    await expect(UnlockDetailPage({ params: Promise.resolve({ postId: 'unlock-1' }) }))
      .rejects.toThrow('NEXT_REDIRECT:/login?returnUrl=/unlocks/unlock-1');
    expect(getViewerUnlockDetailMock).not.toHaveBeenCalled();
  });
});
