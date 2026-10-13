import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';

import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import { showConfirmDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { formatCreditAmount, formatUnlockCreditPrice } from '@/lib/pricing';
import type { MobileCommerceSyncResponse, PostResourceBundleFreeUnlockResponse } from '@/lib/types';
import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';

export interface BundleUnlockTarget {
  postId: string;
  resourceId: string;
  accessMode: 'free' | 'paid';
  /** What it costs, in credits: one per US cent (`lib/pricing.ts`). Null until the host knows. */
  priceUsdCents: number | null;
  /** Shown while the number is unknown, e.g. the label the feed already printed. */
  priceLabel?: string | null;
}

export type BundleUnlockResult = PostResourceBundleFreeUnlockResponse | MobileCommerceSyncResponse;

/** How short of the price the known balance is; 0 when it is enough, or not known. */
export function getBundleUnlockShortfall(
  target: Pick<BundleUnlockTarget, 'accessMode' | 'priceUsdCents'> | null,
  credits: number | null
) {
  if (!target || target.accessMode !== 'paid' || target.priceUsdCents === null || credits === null) return 0;
  return Math.max(0, Math.trunc(target.priceUsdCents) - credits);
}

export function formatBundleUnlockShortfall(shortfall: number) {
  return shortfall > 0 ? `You need ${formatCreditAmount(shortfall)} more credits for this unlock.` : null;
}

/** The marketplace's words for the spend, now everyone's. */
export function describePaidUnlockConfirmation(priceLabel: string | null) {
  return {
    title: 'Unlock this resource?',
    message: `${priceLabel ?? 'The price'} will come off your credit balance right away.`,
    confirmLabel: priceLabel ? `Unlock for ${priceLabel}` : 'Unlock with credits',
  };
}

/** The credit unlock refuses a short balance with 402 (src/lib/mobile-commerce.ts). */
export function isInsufficientCreditsError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { status?: unknown }).status === 402);
}

/**
 * Unlocking a post's recipe, the one way: the Details card, the remix sheet and
 * the marketplace screen each had their own, and only the marketplace asked
 * before spending, showed a shortfall with a way to buy credits, kept the
 * balance current and sent sign-in back to where it started.
 *
 * - Free: one tap.
 * - Paid: asks first, in the marketplace's words. Not offered while the known
 *   balance is short; `shortfallMessage` and `goToCredits` say so instead.
 * - The balance the credit unlock leaves is applied at once.
 * - Signed out: sign-in, coming back to `authReturnTo`.
 */
export function useBundleUnlock({
  authReturnTo,
  confirmWith = 'action-sheet',
  onLeave,
  onUnlocked,
  target,
}: {
  authReturnTo?: string;
  /**
   * How a paid unlock asks. The action sheet draws in the app's own window, so
   * a host that is itself an RN `Modal` (the remix sheet) would hide it; the
   * dialog draws above a Modal on both platforms (`lib/dialog.ts`).
   */
  confirmWith?: 'action-sheet' | 'dialog';
  /** Runs before leaving for sign-in or credits, so a sheet can close first. */
  onLeave?: () => void;
  onUnlocked?: (result: BundleUnlockResult, target: BundleUnlockTarget) => void | Promise<void>;
  target: BundleUnlockTarget | null;
}) {
  const { api, credits, updateCredits, user } = useAuth();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (unlock: BundleUnlockTarget): Promise<BundleUnlockResult> => (
      unlock.accessMode === 'free'
        ? api.unlockFreeBundle(unlock.postId)
        : api.unlockBundleWithCredits(unlock.postId)
    ),
    onSuccess: async (result, unlock) => {
      if (result && 'credits' in result && typeof result.credits === 'number') {
        updateCredits(result.credits);
      }
      await refreshUnlockedBundleCaches(queryClient, unlock);
      haptic.select();
      await onUnlocked?.(result, unlock);
    },
  });

  const priceLabel = !target
    ? null
    : target.accessMode === 'free'
      ? 'Free'
      : typeof target.priceUsdCents === 'number'
        ? formatUnlockCreditPrice(target.priceUsdCents)
        : target.priceLabel ?? null;
  const shortfall = user ? getBundleUnlockShortfall(target, credits) : 0;

  const goToCredits = () => {
    onLeave?.();
    router.push('/pricing' as never);
  };

  const request = () => {
    if (!user) {
      onLeave?.();
      router.push((authReturnTo ? { pathname: '/auth', params: { returnTo: authReturnTo } } : '/auth') as never);
      return;
    }
    if (!target || mutation.isPending) return;
    if (target.accessMode === 'free') {
      mutation.mutate(target);
      return;
    }
    if (shortfall > 0) return;

    // A paid unlock spends the balance at once and cannot be undone.
    const unlock = target;
    const { title, message, confirmLabel } = describePaidUnlockConfirmation(priceLabel);
    if (confirmWith === 'dialog') {
      void showConfirmDialog({ title, message, confirmLabel }).then((confirmed) => {
        if (confirmed) mutation.mutate(unlock);
      });
      return;
    }
    showActionSheet({ title, message, actions: [{ label: confirmLabel, onPress: () => mutation.mutate(unlock) }] });
  };

  // A host that stays mounted across posts (the remix sheet does) shows only
  // the attempt made for the bundle it is showing now.
  const attempt = mutation.variables;
  const ownAttempt = Boolean(target && attempt
    && attempt.postId === target.postId && attempt.resourceId === target.resourceId);
  const attemptError = ownAttempt ? mutation.error : null;

  return {
    error: attemptError instanceof Error ? attemptError.message : null,
    goToCredits,
    isPending: ownAttempt && mutation.isPending,
    /** A known shortfall, or the server refusing for want of credits: "Get credits" belongs under the button. */
    offersCredits: shortfall > 0 || isInsufficientCreditsError(attemptError),
    priceLabel,
    request,
    shortfall,
    shortfallMessage: formatBundleUnlockShortfall(shortfall),
  };
}
