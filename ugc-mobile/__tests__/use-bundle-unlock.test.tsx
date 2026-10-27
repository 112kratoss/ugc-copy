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
    marketplaceSpendableCredits: 2000 as number | null,
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

import { readRecipeUnlockedNotice } from '@/lib/recipe-unlocked-notice';
import {
  describePaidUnlockConfirmation,
  formatBundleUnlockShortfall,
  getBundleUnlockShortfall,
  getUnlockSpendableCredits,
  holdsPromotionalCredits,
  formatPriceChange,
  isInsufficientCreditsError,
  readInsufficientCreditsRefusal,
  readPriceChangedRefusal,
  useBundleUnlock,
  type BundleUnlockTarget,
} from '@/lib/use-bundle-unlock';

type HookOptions = Parameters<typeof useBundleUnlock>[0];
type HookResult = ReturnType<typeof useBundleUnlock>;
type SheetRequest = { actions: Array<{ label: string; onPress: () => void }> };

const paid: BundleUnlockTarget = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'paid', priceUsdCents: 900 };
const free: BundleUnlockTarget = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'free', priceUsdCents: 0 };

const PROMOTIONAL_SHORTFALL = "You need 900 more credits. Welcome and referral credits can't be spent on recipes.";

/**
 * The credit unlock's 402 as the API client throws it: an `ApiError` whose
 * `code` and `details` are the body's (`mobile-api-contract-fixture.test.ts`
 * pins that hand-over).
 */
function insufficientCreditsError(
  figures: { creditCost?: number; remainingCredits?: number | null; marketplaceSpendableCredits?: number | null } = {},
) {
  const body = {
    code: 'INSUFFICIENT_CREDITS',
    creditCost: 900,
    remainingCredits: 1200,
    marketplaceSpendableCredits: 0,
    ...figures,
  };
  const message = `Insufficient credits. This unlock costs ${body.creditCost} credits.`;
  return Object.assign(new Error(message), {
    status: 402,
    code: 'INSUFFICIENT_CREDITS',
    details: { error: message, ...body },
  });
}

/**
 * The credit unlock's 409 when the price is no longer the one the buyer
 * confirmed (S3): nothing was charged, and the body names the price now.
 */
function priceChangedError(priceCredits: number) {
  const message = `The price changed to ${priceCredits} credits.`;
  return Object.assign(new Error(message), {
    status: 409,
    code: 'RESOURCE_PRICE_CHANGED',
    details: { success: false, code: 'RESOURCE_PRICE_CHANGED', error: message, priceCredits },
  });
}

/** What the auth context does with a balance it is handed (`updateCredits` in lib/auth.tsx). */
function applyCredits(credits: number | null, options?: { marketplaceSpendableCredits?: number | null }) {
  authState.credits = credits;
  if (options?.marketplaceSpendableCredits !== undefined) {
    authState.marketplaceSpendableCredits = options.marketplaceSpendableCredits;
  }
}

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
  authState.marketplaceSpendableCredits = 2000;
  authState.updateCredits.mockReset();
  authState.updateCredits.mockImplementation(applyCredits);
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

  it('says the shortfall in the recipe words, with a thousands separator and one credit as one', () => {
    expect(formatBundleUnlockShortfall(1800)).toBe('You need 1,800 more credits.');
    expect(formatBundleUnlockShortfall(1)).toBe('You need 1 more credit.');
    expect(formatBundleUnlockShortfall(0)).toBeNull();
  });

  it('counts what the unlock can spend: the spendable part, or the total while that is all the app knows', () => {
    expect(getUnlockSpendableCredits(1200, 0)).toBe(0);
    expect(getUnlockSpendableCredits(1500, 1200)).toBe(1200);
    expect(getUnlockSpendableCredits(1200, null)).toBe(1200);
    expect(getUnlockSpendableCredits(1200, undefined)).toBe(1200);
    expect(getUnlockSpendableCredits(null, null)).toBeNull();
  });

  it('knows when the total holds welcome and referral credits', () => {
    expect(holdsPromotionalCredits(1200, 0)).toBe(true);
    expect(holdsPromotionalCredits(1500, 1200)).toBe(true);
    expect(holdsPromotionalCredits(1200, 1200)).toBe(false);
    expect(holdsPromotionalCredits(1200, null)).toBe(false);
    expect(holdsPromotionalCredits(null, 0)).toBe(false);
  });

  it('says why the total does not count, in the decided words, only beside a shortfall', () => {
    expect(formatBundleUnlockShortfall(900, { promotionalCredits: true })).toBe(PROMOTIONAL_SHORTFALL);
    expect(formatBundleUnlockShortfall(0, { promotionalCredits: true })).toBeNull();
  });

  it("reads what the server counted when it refused for want of credits", () => {
    expect(readInsufficientCreditsRefusal(insufficientCreditsError())).toEqual({
      creditCost: 900,
      remainingCredits: 1200,
      marketplaceSpendableCredits: 0,
    });
    expect(readInsufficientCreditsRefusal(insufficientCreditsError({ marketplaceSpendableCredits: null })))
      .toMatchObject({ marketplaceSpendableCredits: null });
    // A refusal that sent no figures, and every other failure, have nothing to read.
    expect(readInsufficientCreditsRefusal(Object.assign(new Error('Insufficient credits.'), { status: 402 }))).toBeNull();
    expect(readInsufficientCreditsRefusal(Object.assign(new Error('Slow down.'), {
      status: 429,
      code: 'RATE_LIMITED',
      details: { error: 'Slow down.', code: 'RATE_LIMITED', creditCost: 900 },
    }))).toBeNull();
    expect(readInsufficientCreditsRefusal(new Error('offline'))).toBeNull();
  });

  it('asks in the glossary words, and never with an empty price', () => {
    expect(describePaidUnlockConfirmation('900 credits')).toEqual({
      title: 'Unlock this recipe?',
      message: '900 credits will come off your balance.',
      confirmLabel: 'Unlock for 900 credits',
    });
    expect(describePaidUnlockConfirmation(null).confirmLabel).toBe('Unlock with credits');
    // Asked again after the price moved: the change leads.
    expect(describePaidUnlockConfirmation('1,200 credits', { priceChanged: true }).message)
      .toBe('The price changed to 1,200 credits. 1,200 credits will come off your balance.');
  });

  it("reads the server's refusal when the price moved under the buyer, and nothing else", () => {
    expect(readPriceChangedRefusal(priceChangedError(1200))).toEqual({ priceCredits: 1200 });
    expect(readPriceChangedRefusal(insufficientCreditsError())).toBeNull();
    expect(readPriceChangedRefusal(Object.assign(new Error('Conflict'), { status: 409, code: 'SESSION_MERGED', details: { priceCredits: 5 } }))).toBeNull();
    expect(readPriceChangedRefusal(new Error('offline'))).toBeNull();
    expect(formatPriceChange(1200)).toBe('The price changed to 1,200 credits.');
    expect(formatPriceChange(1)).toBe('The price changed to 1 credit.');
  });

  it("recognises the server's refusal for want of credits, by its status or its code", () => {
    expect(isInsufficientCreditsError({ status: 402 })).toBe(true);
    expect(isInsufficientCreditsError({ code: 'INSUFFICIENT_CREDITS' })).toBe(true);
    expect(isInsufficientCreditsError(insufficientCreditsError())).toBe(true);
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
    expect(sheet.title).toBe('Unlock this recipe?');
    expect(sheet.message).toBe('900 credits will come off your balance.');
    expect(sheet.actions.map((action) => action.label)).toEqual(['Unlock for 900 credits']);

    renderer.act(() => sheet.actions[0]!.onPress());
    await settle();

    // The price the buyer confirmed goes with the spend, so a reprice in
    // between charges nothing (S3).
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledWith('post-1', 900);
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
      title: 'Unlock this recipe?',
      message: '900 credits will come off your balance.',
      confirmLabel: 'Unlock for 900 credits',
    });
    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();

    renderer.act(() => state.current!.request());
    await settle();
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledTimes(1);
  });

  it('offers credits instead of a doomed spend when the known balance is short', () => {
    authState.credits = 100;
    authState.marketplaceSpendableCredits = 100;
    const onLeave = vi.fn();
    const { state } = renderHook({ target: paid, onLeave });

    expect(state.current!.shortfall).toBe(800);
    expect(state.current!.shortfallMessage).toBe('You need 800 more credits.');
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
    authState.marketplaceSpendableCredits = null;
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

  it('holds the spend when only welcome and referral credits would pay, though the total covers the price', () => {
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 0;
    const { state } = renderHook({ target: paid });

    expect(state.current!.shortfall).toBe(900);
    expect(state.current!.shortfallMessage).toBe(PROMOTIONAL_SHORTFALL);
    expect(state.current!.offersCredits).toBe(true);

    renderer.act(() => state.current!.request());
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(authState.api.unlockBundleWithCredits).not.toHaveBeenCalled();
  });

  it('asks as before when the spendable part covers the price, whatever else the total holds', () => {
    authState.credits = 1500;
    authState.marketplaceSpendableCredits = 1200;
    const { state } = renderHook({ target: paid });

    expect(state.current!.shortfall).toBe(0);
    expect(state.current!.shortfallMessage).toBeNull();
    expect(state.current!.offersCredits).toBe(false);
    renderer.act(() => state.current!.request());
    expect(showActionSheet).toHaveBeenCalledTimes(1);
  });

  it('counts against the total while the spendable part is unknown', () => {
    authState.credits = 100;
    authState.marketplaceSpendableCredits = null;
    const { state } = renderHook({ target: paid });

    expect(state.current!.shortfall).toBe(800);
    expect(state.current!.shortfallMessage).toBe('You need 800 more credits.');
  });

  it('applies the spendable figure the unlock answers with', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({
      success: true,
      entitlement: 'post_resource_unlock',
      credits: 1100,
      marketplaceSpendableCredits: 500,
    });
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    expect(authState.updateCredits).toHaveBeenCalledWith(1100, { marketplaceSpendableCredits: 500 });
  });

  it("takes the server's count when it refuses, and says its shortfall instead of the refusal", async () => {
    // The app held all 1,200 as spendable; the server counted none of them.
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 1200;
    authState.api.unlockBundleWithCredits.mockRejectedValue(insufficientCreditsError());
    const { state, update } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    expect(authState.updateCredits).toHaveBeenCalledWith(1200, { marketplaceSpendableCredits: 0 });
    expect(state.current!.error).toBeNull();
    expect(state.current!.shortfall).toBe(900);
    expect(state.current!.shortfallMessage).toBe(PROMOTIONAL_SHORTFALL);
    expect(state.current!.offersCredits).toBe(true);

    // Credits bought since: nothing of the refusal is left standing.
    applyCredits(2200, { marketplaceSpendableCredits: 1000 });
    update({ target: paid });
    expect(state.current!.shortfall).toBe(0);
    expect(state.current!.shortfallMessage).toBeNull();
    expect(state.current!.error).toBeNull();
    expect(state.current!.offersCredits).toBe(false);
  });

  it('prices the shortfall from the refusal when the host had no price to give', async () => {
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 1200;
    authState.api.unlockBundleWithCredits.mockRejectedValue(insufficientCreditsError());
    showConfirmDialog.mockResolvedValue(true);
    const unpriced: BundleUnlockTarget = { ...paid, priceUsdCents: null, priceLabel: '900 credits' };
    const { state } = renderHook({ target: unpriced, confirmWith: 'dialog' });

    expect(state.current!.shortfall).toBe(0);
    renderer.act(() => state.current!.request());
    await settle();

    expect(state.current!.shortfall).toBe(900);
    expect(state.current!.shortfallMessage).toBe(PROMOTIONAL_SHORTFALL);
    expect(state.current!.error).toBeNull();
  });

  it("keeps the server's words when its figures do not account for the refusal", async () => {
    // The price rose to 1,200 under a screen that still shows 900.
    authState.credits = 1000;
    authState.marketplaceSpendableCredits = 1000;
    authState.api.unlockBundleWithCredits.mockRejectedValue(insufficientCreditsError({
      creditCost: 1200,
      remainingCredits: 1000,
      marketplaceSpendableCredits: 1000,
    }));
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    expect(state.current!.shortfall).toBe(0);
    expect(state.current!.error).toBe('Insufficient credits. This unlock costs 1200 credits.');
    expect(state.current!.offersCredits).toBe(true);
  });

  it('leaves the balance alone when the refusal could not say what was spendable', async () => {
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 1200;
    authState.api.unlockBundleWithCredits.mockRejectedValue(insufficientCreditsError({ marketplaceSpendableCredits: null }));
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    expect(authState.updateCredits).not.toHaveBeenCalled();
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

describe('a price that moved under the buyer (S3)', () => {
  it('says so, has the hosts read the recipe again, and asks again at the new price', async () => {
    authState.api.unlockBundleWithCredits
      .mockRejectedValueOnce(priceChangedError(1200))
      .mockResolvedValueOnce({ success: true, entitlement: 'post_resource_unlock', credits: 800 });
    const onUnlocked = vi.fn();
    const { invalidate, state } = renderHook({ target: paid, onUnlocked });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    // Nothing was charged; the buyer is told, in credits, and asked again.
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledTimes(1);
    expect(authState.api.unlockBundleWithCredits).toHaveBeenLastCalledWith('post-1', 900);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(state.current!.error).toBe('The price changed to 1,200 credits.');
    expect(state.current!.priceChanged).toBe(true);
    expect(state.current!.priceLabel).toBe('1,200 credits');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['post-resource-bundle', 'post-1', 'asset-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketplace-resource', 'asset-1'] });
    expect(showActionSheet).toHaveBeenCalledTimes(2);
    const again = showActionSheet.mock.calls[1]?.[0] as { title: string; message: string; actions: Array<{ label: string; onPress: () => void }> };
    expect(again.title).toBe('Unlock this recipe?');
    expect(again.message).toBe('The price changed to 1,200 credits. 1,200 credits will come off your balance.');
    expect(again.actions.map((action) => action.label)).toEqual(['Unlock for 1,200 credits']);

    renderer.act(() => again.actions[0]!.onPress());
    await settle();

    expect(authState.api.unlockBundleWithCredits).toHaveBeenLastCalledWith('post-1', 1200);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(state.current!.error).toBeNull();
  });

  it('asks again through the dialog for a host drawn in a Modal', async () => {
    authState.api.unlockBundleWithCredits.mockRejectedValueOnce(priceChangedError(1200));
    showConfirmDialog.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { state } = renderHook({ target: paid, confirmWith: 'dialog' });

    renderer.act(() => state.current!.request());
    await settle();
    await settle();

    expect(showActionSheet).not.toHaveBeenCalled();
    expect(showConfirmDialog).toHaveBeenLastCalledWith({
      title: 'Unlock this recipe?',
      message: 'The price changed to 1,200 credits. 1,200 credits will come off your balance.',
      confirmLabel: 'Unlock for 1,200 credits',
    });
    // Declined: nothing more is spent, and the new price stays on the button.
    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledTimes(1);
    expect(state.current!.priceLabel).toBe('1,200 credits');
  });

  it('keeps the new price until the host reads it, then follows the host', async () => {
    authState.api.unlockBundleWithCredits.mockRejectedValueOnce(priceChangedError(1200));
    const { state, update } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();
    expect(state.current!.priceLabel).toBe('1,200 credits');

    // The host's read of the recipe catches up, then moves again.
    update({ target: { ...paid, priceUsdCents: 1200 } });
    expect(state.current!.priceLabel).toBe('1,200 credits');
    update({ target: { ...paid, priceUsdCents: 1500 } });
    expect(state.current!.priceLabel).toBe('1,500 credits');
  });

  it('asks nothing when the new price is beyond the balance, and offers credits instead', async () => {
    authState.credits = 1000;
    authState.marketplaceSpendableCredits = 1000;
    authState.api.unlockBundleWithCredits.mockRejectedValueOnce(priceChangedError(1200));
    const { state } = renderHook({ target: paid });

    renderer.act(() => state.current!.request());
    renderer.act(() => (showActionSheet.mock.calls[0]?.[0] as SheetRequest).actions[0]!.onPress());
    await settle();

    expect(showActionSheet).toHaveBeenCalledTimes(1);
    expect(state.current!.error).toBe('The price changed to 1,200 credits.');
    expect(state.current!.shortfall).toBe(200);
    expect(state.current!.shortfallMessage).toBe('You need 200 more credits.');
    expect(state.current!.offersCredits).toBe(true);
  });

  it('sends no price when the host could not say one, as builds before the change did', async () => {
    authState.api.unlockBundleWithCredits.mockResolvedValue({ success: true, entitlement: 'post_resource_unlock', credits: 1100 });
    showConfirmDialog.mockResolvedValue(true);
    const { state } = renderHook({ target: { ...paid, priceUsdCents: null, priceLabel: '900 credits' }, confirmWith: 'dialog' });

    renderer.act(() => state.current!.request());
    await settle();

    expect(authState.api.unlockBundleWithCredits).toHaveBeenCalledWith('post-1', undefined);
  });
});

describe('after an unlock', () => {
  it('says "Recipe unlocked" with the way to Unlocked recipes, from every host', async () => {
    authState.api.unlockFreeBundle.mockResolvedValue({ success: true, free: true, alreadyProcessed: false });
    const before = readRecipeUnlockedNotice();
    const { state } = renderHook({ target: free });

    renderer.act(() => state.current!.request());
    await settle();

    const shown = readRecipeUnlockedNotice();
    expect(shown).not.toBeNull();
    expect(shown).not.toBe(before);
  });

  it('says nothing when the unlock fails', async () => {
    authState.api.unlockFreeBundle.mockRejectedValue(new Error('offline'));
    const before = readRecipeUnlockedNotice();
    const { state } = renderHook({ target: free });

    renderer.act(() => state.current!.request());
    await settle();

    expect(readRecipeUnlockedNotice()).toBe(before);
  });
});
