import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adoptVisitorDraft: vi.fn<(tool: string, userId: string, nonce: string | null) => Promise<boolean>>(),
  hasVisitorDraftHandover: vi.fn<(tool: string, nonce: string | null) => boolean>(),
}));

vi.mock('@/lib/creator-visitor-draft', () => ({
  VISITOR_DRAFT_OWNER: 'visitor',
  adoptVisitorDraft: mocks.adoptVisitorDraft,
  hasVisitorDraftHandover: mocks.hasVisitorDraftHandover,
}));

async function loadHook() {
  return (await import('@/lib/use-creator-draft-owner')).useCreatorDraftOwner;
}

describe('whose draft a creator keeps', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.adoptVisitorDraft.mockReset();
    mocks.hasVisitorDraftHandover.mockReset();
    mocks.hasVisitorDraftHandover.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the visitor’s on a page that opened signed out', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result } = renderHook(() => useCreatorDraftOwner('video', null, null));
    expect(result.current).toEqual({ owner: 'visitor', carriedDraft: false });
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('has the account’s at once on a page no sign-up of this creator led to', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', null));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false });
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('keeps nothing once a page that opened signed in loses its session, so the account’s form never lands in the visitor slot', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result, rerender } = renderHook(({ userId }) => useCreatorDraftOwner('image', userId, null), {
      initialProps: { userId: 'user-1' as string | null },
    });
    expect(result.current.owner).toBe('user-1');

    rerender({ userId: null });
    expect(result.current).toEqual({ owner: null, carriedDraft: false });
  });

  it('waits for the visitor’s draft to move to the account on the way back from this creator’s sign-up', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    let finish: (moved: boolean) => void = () => undefined;
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useCreatorDraftOwner('image', 'user-1', 'nonce-1234'));

    // Not moved yet: nothing restores or saves until the hand-over is done.
    expect(result.current.owner).toBeNull();
    expect(mocks.hasVisitorDraftHandover).toHaveBeenCalledWith('image', 'nonce-1234');
    expect(mocks.adoptVisitorDraft).toHaveBeenCalledWith('image', 'user-1', 'nonce-1234');

    await act(async () => finish(true));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: true });
  });

  it('moves once when React runs the effect twice, and waits for that one move', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    let finish: (moved: boolean) => void = () => undefined;
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', 'nonce-5678'), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });

    expect(mocks.adoptVisitorDraft).toHaveBeenCalledTimes(1);
    expect(result.current.owner).toBeNull();
    await act(async () => finish(true));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: true });
  });

  it('goes on with the account’s draft when the hand-over fails', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('storage refused'));
    const { result } = renderHook(() => useCreatorDraftOwner('motion', 'user-1', 'nonce-9999'));
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false }));
  });

  it('keeps the first answer when a slow move lands after the give-up', async () => {
    vi.useFakeTimers();
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    let finish: (moved: boolean) => void = () => undefined;
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', 'nonce-slow'));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false });
    await act(async () => finish(true));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false });
  });

  it('goes on without a hand-over that never answers', async () => {
    vi.useFakeTimers();
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', 'nonce-0000'));
    expect(result.current.owner).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false });
  });
});
