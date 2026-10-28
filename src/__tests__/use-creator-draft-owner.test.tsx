import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adoptVisitorDraft: vi.fn<(tool: string, userId: string) => Promise<boolean>>(),
  hasVisitorDraftHandover: vi.fn<(tool: string) => boolean>(),
}));

vi.mock('@/lib/creator-visitor-draft', () => ({
  VISITOR_DRAFT_OWNER: 'visitor',
  adoptVisitorDraft: mocks.adoptVisitorDraft,
  hasVisitorDraftHandover: mocks.hasVisitorDraftHandover,
}));

import { useCreatorDraftOwner } from '@/lib/use-creator-draft-owner';

describe('whose draft a creator keeps', () => {
  beforeEach(() => {
    mocks.adoptVisitorDraft.mockReset();
    mocks.hasVisitorDraftHandover.mockReset();
    mocks.hasVisitorDraftHandover.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the visitor’s while nobody is signed in', () => {
    const { result } = renderHook(() => useCreatorDraftOwner('video', null));
    expect(result.current).toBe('visitor');
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('has the account’s at once on a page no sign-up of this creator led to', () => {
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1'));
    expect(result.current).toBe('user-1');
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('waits for the visitor’s draft to be moved to the account after this creator’s sign-up', async () => {
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    let finish: (moved: boolean) => void = () => undefined;
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useCreatorDraftOwner('image', 'user-1'));

    // Not moved yet: nothing restores or saves until the hand-over is done.
    expect(result.current).toBeNull();
    expect(mocks.hasVisitorDraftHandover).toHaveBeenCalledWith('image');
    expect(mocks.adoptVisitorDraft).toHaveBeenCalledWith('image', 'user-1');

    await act(async () => finish(true));
    expect(result.current).toBe('user-1');
  });

  it('goes on with the account’s draft when the hand-over fails', async () => {
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('storage refused'));
    const { result } = renderHook(() => useCreatorDraftOwner('motion', 'user-1'));
    await waitFor(() => expect(result.current).toBe('user-1'));
  });

  it('goes on without a hand-over that never answers', async () => {
    vi.useFakeTimers();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1'));
    expect(result.current).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe('user-1');
  });

  it('moves the draft for an account that signs in while the page is open', async () => {
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockResolvedValue(true);
    const { result, rerender } = renderHook(({ userId }) => useCreatorDraftOwner('video', userId), {
      initialProps: { userId: null as string | null },
    });
    expect(result.current).toBe('visitor');

    rerender({ userId: 'user-2' });
    await waitFor(() => expect(result.current).toBe('user-2'));
    expect(mocks.adoptVisitorDraft).toHaveBeenCalledWith('video', 'user-2');
  });
});
