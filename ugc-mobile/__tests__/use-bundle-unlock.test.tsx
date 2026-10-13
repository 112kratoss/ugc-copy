// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, router, showActionSheet, showConfirmDialog } = vi.hoisted(() => ({
  authState: {
    api: {
      unlockBundleWithCredits: vi.fn(),
      unlockFreeBundle: vi.fn(),
    },
    credits: 2000 as number | null,
    updateCredits: vi.fn(),
    user: { id: 'buyer-1' } as { id: string } | null,
  },
  router: { push: vi.fn() },
  showActionSheet: vi.fn(),
  showConfirmDialog: vi.fn(),
}));

// lib/haptics reads Platform; nothing here renders a native view.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-router', () => ({ router }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet }));
vi.mock('@/lib/dialog', () => ({ showConfirmDialog }));

import {
  describePaidUnlockConfirmation,
  formatBundleUnlockShortfall,
  getBundleUnlockShortfall,
  isInsufficientCreditsError,
  useBundleUnlock,
  type BundleUnlockTarget,
} from '@/lib/use-bundle-unlock';

type HookOptions = Parameters<typeof useBundleUnlock>[0];
type HookResult = ReturnType<typeof useBundleUnlock>;

const paid: BundleUnlockTarget = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'paid', priceUsdCents: 900 };
const free: BundleUnlockTarget = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'free', priceUsdCents: 0 };

function Harness({ options, onRender }: { options: HookOptions; onRender: (result: HookResult) => void }) {
  onRender(useBundleUnlock(options));
  return null;
}

function renderHook(options: HookOptions) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const state: { current: HookResult | null } = { current: null };
  const element = (next: HookOptions) => (
    <QueryClientProvider client={queryClient}>
      <Harness options={next} onRender={(result) => { state.current = result; }} />
    </QueryClientProvider>
  );
  let tree: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element(options));
  });
  const update = (next: HookOptions) => renderer.act(() => tree.update(element(next)));
  return { invalidate, state, update };
}

// React Query tells observers on a zero timeout, so a settled mutation reaches
// the render one macrotask later.
async function settle() {
  await renderer.act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  authState.api.unlockBundleWithCredits.mockReset();
  authState.api.unlockFreeBundle.mockReset();
  authState.credits = 2000;
  authState.updateCredits.mockClear();
  authState.user = { id: 'buyer-1' };
  router.push.mockClear();
  showActionSheet.mockClear();
  showConfirmDialog.mockReset();
});

describe('bundle unlock rules', () => {
  it('counts a shortfall only against a known balance and a known price', () => {
    expect(getBundleUnlockShortfall(paid, 100)).toBe(800);
    expect(getBundleUnlockShortfall(paid, 900)).toBe(0);
    expect(getBundleUnlockShortfall(paid, null)).toBe(0);
    expect(getBundleUnlockShortfall({ ...paid, priceUsdCents: null }, 100)).toBe(0);
    expect(getBundleUnlockShortfall(free, 0)).toBe(0);
  });

  it('says the shortfall in the marketplace words, with a thousands separator', () => {
    expect(formatBundleUnlockShortfall(1800)).toBe('You need 1,800 more credits for this unlock.');
    expect(formatBundleUnlockShortfall(0)).toBeNull();
  });

  it('asks in the marketplace words, and never with an empty price', () => {
    expect(describePaidUnlockConfirmation('900 credits')).toEqual({
      title: 'Unlock this resource?',
      message: '900 credits will come off your credit balance right away.',
      confirmLabel: 'Unlock for 900 credits',
    });
    expect(describePaidUnlockConfirmation(null).confirmLabel).toBe('Unlock with credits');
  });

  it("recognises the server's refusal for want of credits", () => {
    expect(isInsufficientCreditsError({ status: 402 })).toBe(true);
    expect(isInsufficientCreditsError({ status: 403 })).toBe(false);
    expect(isInsufficientCreditsError(new Error('offline'))).toBe(false);
  });
});

describe('useBundleUnlock', () => {
  it('takes a free bundle in one tap and refreshes the library behind it', async () => {
    authState.api.unlockFreeBundle.mockResolvedValue({ success: true, free: true, alreadyProcessed: false });
    const onUnlocked = vi.fn();
    const { invalidate, state } = renderHook({ target: free, onUnlocked });

    renderer.act(() => state.current!.request());
    await settle();

    expect(showActionSheet).not.toHaveBeenCalled();
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(authState.api.unlockFreeBundle).toHaveBeenCalledWith('post-1');
    expect(authState.updateCredits).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['viewer-unlocks'] });
    expect(onUnlocked).toHaveBeenCalledWith(expect.objectContaining({ free: true }), free);
  });

  it('asks before a paid unlock, spends only on the confirmed action, and applies the balance it left', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true, entitlement: 'post_resource_unlock', credits: 1100 });
    const onUnlocked = vi.fn();
    const { state } = renderHook({ target: paid, onUnlocked });

    renderer.act(() => state.current!.request());
    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();
    const sheet = showActionSheet.mock.calls[0]?.[0] as { title: string; message: string; actions: Array<{ label: string; onPress: () => void }> };
    expect(sheet.title).toBe('Unlock this resource?');
    expect(sheet.message).toBe('900 credits will come off your credit balance right away.');
    expect(sheet.actions.map((action) => action.label)).toEqual(['Unlock for 900 credits']);

    renderer.act(() => sheet.actions[0]!.onPress());
    await settle();

    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledWith('post-1');
    expect(authState.updateCredits).toHaveBeenCalledWith(1100);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it('asks through the dialog for a host drawn in a Modal, and does nothing when declined', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true, entitlement: 'post_resource_unlock', credits: 1100 });
    showConfirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { state } = renderHook({ target: paid, confirmWith: 'dialog' });

    renderer.act(() => state.current!.request());
    await settle();
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: 'Unlock this resource?',
      message: '900 credits will come off your credit balance right away.',
      confirmLabel: 'Unlock for 900 credits',
    });
    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();

    renderer.act(() => state.current!.request());
    await settle();
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledTimes(1);
  });

  it('offers credits instead of a doomed spend when the known balance is short', () => {
    authState.credits = 100;
    const onLeave = vi.fn();
    const { state } = renderHook({ target: paid, onLeave });

    expect(state.current!.shortfall).toBe(800);
    expect(state.current!.shortfallMessage).toBe('You need 800 more credits for this unlock.');
    expect(state.current!.offersCredits).toBe(true);

    renderer.act(() => state.current!.request());
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();

    renderer.act(() => state.current!.goToCredits());
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/pricing');
  });

  it('offers credits when the server refuses for want of them', async () => {
    authState.credits = null;
    authState.api.unlockBundleWithCredits.mockRejectedValue(Object.assign(
      new Error('Insufficient credits. This unlock costs 900 credits.'),
      { status: 402 },
    ));
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as { actions: Array<{ onPress: () => void }> }).actions[0]!.onPress());
    await settle();

    expect(state.current!.error).toBe('Insufficient credits. This unlock costs 900 credits.');
    expect(state.current!.offersCredits).toBe(true);
  });

  it('shows a failed attempt only on the bundle it was made for', async () => {
    authState.api.unlockFreeBundle.mockRejectedValue(new Error('Could not reach Magicbooklet.'));
    const { state, update } = renderHook({ target: free });

    renderer.act(() => state.current!.request());
    await settle();
    expect(state.current!.error).toBe('Could not reach Magicbooklet.');

    // The remix sheet stays mounted and opens for the next post.
    update({ target: { ...free, postId: 'post-2', resourceId: 'asset-2' } });
    expect(state.current!.error).toBeNull();
    update({ target: free });
    expect(state.current!.error).toBe('Could not reach Magicbooklet.');
  });

  it('sends a signed-out reader to sign in and back to where they were', () => {
    authState.user = null;
    authState.credits = 0;
    const onLeave = vi.fn();
    const { state } = renderHook({ target: paid, authReturnTo: '/post/post-1', onLeave });

    // Nothing is short for someone who has not signed in yet.
    expect(state.current!.shortfall).toBe(0);
    renderer.act(() => state.current!.request());
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/post/post-1' } });
    expect(showActionSheet).not.toHaveBeenCalled();
  });

  it('keeps the plain sign-in for a host that names no way back', () => {
    authState.user = null;
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    expect(router.push).toHaveBeenCalledWith('/auth');
  });
});
