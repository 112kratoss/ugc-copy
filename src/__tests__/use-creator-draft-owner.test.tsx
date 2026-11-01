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
    expect(result.current).toEqual({ owner: 'visitor', carriedDraft: false, keepsVisitorForm: false });
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('has the account’s at once on a page no sign-up of this creator led to', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', null));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: false });
    expect(mocks.adoptVisitorDraft).not.toHaveBeenCalled();
  });

  it('keeps nothing once a page that opened signed in loses its session, so the account’s form never lands in the visitor slot', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result, rerender } = renderHook(({ userId }) => useCreatorDraftOwner('image', userId, null), {
      initialProps: { userId: 'user-1' as string | null },
    });
    expect(result.current.owner).toBe('user-1');

    rerender({ userId: null });
    expect(result.current).toEqual({ owner: null, carriedDraft: false, keepsVisitorForm: false });
  });

  // Owner, 2026-11-01: a sign-out made in another tab clears an open creator page; a lapse keeps it.
  it('goes to the visitor’s once this browser signs out the account of a page that opened signed in', async () => {
    const useCreatorDraftOwner = await loadHook();
    const { result, rerender } = renderHook(
      ({ userId, signedOut }) => useCreatorDraftOwner('image', userId, null, signedOut),
      { initialProps: { userId: 'user-1' as string | null, signedOut: false } },
    );
    expect(result.current.owner).toBe('user-1');

    rerender({ userId: null, signedOut: true });
    expect(result.current).toEqual({ owner: 'visitor', carriedDraft: false, keepsVisitorForm: false });
  });

  it('lets a sign-out end the hand-over’s keep of the visitor’s form, as another account would', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('IndexedDB refused'));
    const { result, rerender } = renderHook(
      ({ userId, signedOut }) => useCreatorDraftOwner('image', userId, 'nonce-1', signedOut),
      { initialProps: { userId: 'user-1' as string | null, signedOut: false } },
    );
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true }));

    rerender({ userId: null, signedOut: true });
    expect(result.current.owner).toBe('visitor');
    rerender({ userId: 'user-1', signedOut: false });
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: false });
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
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: true, keepsVisitorForm: false });
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
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: true, keepsVisitorForm: false });
  });

  it('goes on with the account’s draft when the hand-over fails', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('storage refused'));
    const { result } = renderHook(() => useCreatorDraftOwner('motion', 'user-1', 'nonce-9999'));
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true }));
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
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true });
    await act(async () => finish(true));
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true });
  });

  it('hands the page over once, to the first account: a later one signs in as on any other page, that account again included', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('storage refused'));
    const { result, rerender } = renderHook(({ userId }) => useCreatorDraftOwner('image', userId, 'nonce-2468'), {
      initialProps: { userId: null as string | null },
    });
    expect(result.current).toEqual({ owner: 'visitor', carriedDraft: false, keepsVisitorForm: false });

    rerender({ userId: 'user-1' });
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true }));

    // That account signs out in another tab and another signs in: the visitor's form is not theirs.
    rerender({ userId: null });
    expect(result.current).toEqual({ owner: 'visitor', carriedDraft: false, keepsVisitorForm: false });
    rerender({ userId: 'user-2' });
    expect(result.current).toEqual({ owner: 'user-2', carriedDraft: false, keepsVisitorForm: false });
    // Nor is what a visitor added here after that account left: it signs back in to its own.
    rerender({ userId: null });
    rerender({ userId: 'user-1' });
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: false });
    expect(mocks.adoptVisitorDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing of the visitor’s form where the hand-over found nothing to move', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    // The mark was spent already, by another tab that moved the draft.
    mocks.adoptVisitorDraft.mockResolvedValue(false);
    const { result } = renderHook(() => useCreatorDraftOwner('video', 'user-1', 'nonce-1357'));
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: false }));
  });

  it('keeps the visitor’s form through a session that lapses and comes back', async () => {
    const useCreatorDraftOwner = await loadHook();
    mocks.hasVisitorDraftHandover.mockReturnValue(true);
    mocks.adoptVisitorDraft.mockRejectedValue(new Error('storage refused'));
    // Back from sign-up with the session already there: the page opened signed in.
    const { result, rerender } = renderHook(({ userId }) => useCreatorDraftOwner('motion', userId, 'nonce-8642'), {
      initialProps: { userId: 'user-1' as string | null },
    });
    await waitFor(() => expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true }));

    rerender({ userId: null });
    expect(result.current).toEqual({ owner: null, carriedDraft: false, keepsVisitorForm: false });
    rerender({ userId: 'user-1' });
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true });
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
    expect(result.current).toEqual({ owner: 'user-1', carriedDraft: false, keepsVisitorForm: true });
  });
});

// The creators draw their body under this key: a new key is a new body, so nothing of the earlier
// owner's form or run stays on the page (owner, 2026-11-01).
describe('the form a creator holds', () => {
  const owned = (owner: string | null, keepsVisitorForm = false) => ({ owner, carriedDraft: false, keepsVisitorForm });
  type Owned = ReturnType<typeof owned>;

  it.each<[string, Owned[], number[]]>([
    ['the first owner learned after the page opened, a hand-over’s', [owned(null), owned('user-1')], [0, 0]],
    ['a session that lapses and comes back', [owned('user-1'), owned(null), owned('user-1')], [0, 0, 0]],
    ['the account a hand-over that gave up leaves the visitor’s form to', [owned('visitor'), owned(null), owned('user-1', true)], [0, 0, 0]],
  ])('stays the same form for %s', async (_case, drafts, keys) => {
    const { nextCreatorFormHolder } = await import('@/lib/use-creator-draft-owner');
    let holder = { owner: drafts[0].owner, key: 0 };
    const seen = drafts.map((draft) => (holder = nextCreatorFormHolder(holder, draft)).key);
    expect(seen).toEqual(keys);
  });

  it.each<[string, Owned[], number[]]>([
    ['another account signing in from another tab', [owned('user-1'), owned('user-2')], [0, 1]],
    ['another account after a sign-out', [owned('user-1'), owned(null), owned('user-2')], [0, 0, 1]],
    ['an account signing in on a visitor’s page without the sign-up sheet', [owned('visitor'), owned('user-1')], [0, 1]],
    ['a hand-over that carried the visitor’s draft', [owned('visitor'), owned(null), owned('user-1')], [0, 0, 1]],
    ['the visitor, and then another account, after the hand-over’s account left', [owned('visitor'), owned('user-1', true), owned('visitor'), owned('user-2')], [0, 0, 1, 2]],
  ])('is a new form for %s', async (_case, drafts, keys) => {
    const { nextCreatorFormHolder } = await import('@/lib/use-creator-draft-owner');
    let holder = { owner: drafts[0].owner, key: 0 };
    const seen = drafts.map((draft) => (holder = nextCreatorFormHolder(holder, draft)).key);
    expect(seen).toEqual(keys);
  });

  it('moves the key in the render that brings the next owner, and keeps the form’s owner through a lapse, under Strict Mode too', async () => {
    const { useCreatorForm } = await import('@/lib/use-creator-draft-owner');
    const { result, rerender } = renderHook(({ draft }) => useCreatorForm(draft), {
      initialProps: { draft: owned('user-1') },
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    expect(result.current).toMatchObject({ key: 0, owner: 'user-1' });
    rerender({ draft: owned(null) });
    expect(result.current).toMatchObject({ key: 0, owner: 'user-1' });
    rerender({ draft: owned('user-2') });
    expect(result.current).toMatchObject({ key: 1, owner: 'user-2' });
    rerender({ draft: owned('user-2') });
    expect(result.current).toMatchObject({ key: 1, owner: 'user-2' });
  });

  // What the earlier form still has out stops when another owner's takes its place, and goes on
  // when the page is only left.
  it('aborts a form’s signal when another owner’s form replaces it, and not when the page is left', async () => {
    const { useCreatorForm } = await import('@/lib/use-creator-draft-owner');
    const { result, rerender, unmount } = renderHook(({ draft }) => useCreatorForm(draft), {
      initialProps: { draft: owned('visitor') },
    });
    const visitors = result.current.replaced;
    // The hand-over that gave up leaves the visitor's form to the account: the same form.
    rerender({ draft: owned('user-1', true) });
    expect(result.current.replaced).toBe(visitors);
    expect(visitors.aborted).toBe(false);

    rerender({ draft: owned('user-2') });
    expect(visitors.aborted).toBe(true);
    const bens = result.current.replaced;
    expect(bens.aborted).toBe(false);

    unmount();
    expect(bens.aborted).toBe(false);
  });

  // What the server drew for the page (the sign-up's welcome, the posts to start from) is its
  // viewer's: the visitor's before any account, then the first account's, and no later one's.
  it.each<[string, Owned[], boolean[]]>([
    ['a page that opened signed in, and another account after it', [owned('user-1'), owned(null), owned('user-2')], [true, true, false]],
    ['a sign-up return whose hand-over is on its way', [owned(null), owned('user-1'), owned('user-2')], [true, true, false]],
    ['a sign-up return the page first drew for the visitor', [owned('visitor'), owned(null), owned('user-1'), owned('user-2')], [true, true, true, false]],
    ['the first account, back after another', [owned('user-1'), owned('user-2'), owned('user-1')], [true, false, false]],
  ])('holds what the server drew for the page for its viewer’s form: %s', async (_case, drafts, viewers) => {
    const { useCreatorForm } = await import('@/lib/use-creator-draft-owner');
    const { result, rerender } = renderHook(({ draft }) => useCreatorForm(draft), { initialProps: { draft: drafts[0] } });
    const seen = drafts.map((draft) => {
      rerender({ draft });
      return result.current.pageViewer;
    });
    expect(seen).toEqual(viewers);
  });
});
