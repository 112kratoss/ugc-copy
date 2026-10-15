import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';

import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import { showConfirmDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { formatCreditAmount, formatUnlockCreditPrice } from '@/lib/pricing';
import type {
  InsufficientCreditsResponse,
  MobileCommerceSyncResponse,
  PostResourceBundleFreeUnlockResponse,
} from '@/lib/types';
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

/**
 * Why a balance whose total covers a price can still fall short of it: the
 * credit unlock spends only what is left after the welcome and referral
 * credits (the RPC's `marketplace_spendable_credits`), and the total is what
 * the rest of the app shows.
 */
export const PROMOTIONAL_CREDITS_NOTE = "Welcome and referral credits can't be spent on creator resources.";

const INSUFFICIENT_CREDITS_CODE: InsufficientCreditsResponse['code'] = 'INSUFFICIENT_CREDITS';

/**
 * What the credit unlock can spend, as far as the app knows: the spendable
 * part of the balance. While only the total is known, the total, which caps
 * that part, so a shortfall counted against it is still a real one.
 */
export function getUnlockSpendableCredits(credits: number | null, marketplaceSpendableCredits: number | null | undefined) {
  return typeof marketplaceSpendableCredits === 'number' ? marketplaceSpendableCredits : credits;
}

/** True when part of the known total is welcome and referral credits, which the unlock cannot spend. */
export function holdsPromotionalCredits(credits: number | null, marketplaceSpendableCredits: number | null | undefined) {
  return typeof credits === 'number'
    && typeof marketplaceSpendableCredits === 'number'
    && marketplaceSpendableCredits < credits;
}

/** How short of the price the known balance is; 0 when it is enough, or not known. */
export function getBundleUnlockShortfall(
  target: Pick<BundleUnlockTarget, 'accessMode' | 'priceUsdCents'> | null,
  credits: number | null
) {
  if (!target || target.accessMode !== 'paid' || target.priceUsdCents === null || credits === null) return 0;
  return Math.max(0, Math.trunc(target.priceUsdCents) - credits);
}

/**
 * The shortfall in the marketplace's words. When the balance holds welcome
 * and referral credits the note follows, or a buyer who can see a total
 * larger than the price is told only that they need more.
 */
export function formatBundleUnlockShortfall(shortfall: number, { promotionalCredits = false }: { promotionalCredits?: boolean } = {}) {
  if (shortfall <= 0) return null;
  const message = `You need ${formatCreditAmount(shortfall)} more credits for this unlock.`;
  return promotionalCredits ? `${message} ${PROMOTIONAL_CREDITS_NOTE}` : message;
}

/** The marketplace's words for the spend, now everyone's. */
export function describePaidUnlockConfirmation(priceLabel: string | null) {
  return {
    title: 'Unlock this resource?',
    message: `${priceLabel ?? 'The price'} will come off your credit balance right away.`,
    confirmLabel: priceLabel ? `Unlock for ${priceLabel}` : 'Unlock with credits',
  };
}

/** The figures a credit unlock's refusal counted. */
export type InsufficientCreditsRefusal = Pick<
  InsufficientCreditsResponse,
  'creditCost' | 'remainingCredits' | 'marketplaceSpendableCredits'
>;

/**
 * What the credit unlock counted when it refused for want of credits: the API
 * client hands the 402 body over as the error's `details`, with its `code`
 * (src/lib/mobile-commerce.ts). Null for any other failure, and for a refusal
 * that carried no figures.
 */
export function readInsufficientCreditsRefusal(error: unknown): InsufficientCreditsRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (!details || typeof details !== 'object') return null;
  const body = details as Record<string, unknown>;
  if (code !== INSUFFICIENT_CREDITS_CODE && body.code !== INSUFFICIENT_CREDITS_CODE) return null;
  if (typeof body.creditCost !== 'number') return null;
  return {
    creditCost: body.creditCost,
    remainingCredits: typeof body.remainingCredits === 'number' ? body.remainingCredits : null,
    marketplaceSpendableCredits: typeof body.marketplaceSpendableCredits === 'number' ? body.marketplaceSpendableCredits : null,
  };
}

/** The credit unlock refuses a short balance with 402 `INSUFFICIENT_CREDITS` (src/lib/mobile-commerce.ts). */
export function isInsufficientCreditsError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return status === 402 || code === INSUFFICIENT_CREDITS_CODE || readInsufficientCreditsRefusal(error) !== null;
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
 *   The balance that counts is what the unlock can spend, which leaves out
 *   welcome and referral credits.
 * - The balance the credit unlock leaves, or the one it counted when it
 *   refused for want of credits, is applied at once.
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
  const { api, credits, marketplaceSpendableCredits, updateCredits, user } = useAuth();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (unlock: BundleUnlockTarget): Promise<BundleUnlockResult> => (
      unlock.accessMode === 'free'
        ? api.unlockFreeBundle(unlock.postId)
        : api.unlockBundleWithCredits(unlock.postId)
    ),
    onSuccess: async (result, unlock) => {
      if (result && 'credits' in result && typeof result.credits === 'number') {
        if (typeof result.marketplaceSpendableCredits === 'number') {
          updateCredits(result.credits, { marketplaceSpendableCredits: result.marketplaceSpendableCredits });
        } else {
          updateCredits(result.credits);
        }
      }
      await refreshUnlockedBundleCaches(queryClient, unlock);
      haptic.select();
      await onUnlocked?.(result, unlock);
    },
    onError: (error) => {
      // The app asked because the balance it held covered the price, or
      // because it held none. The server's count becomes the balance, so every
      // surface shows the shortfall it refused on, not a balance that still
      // reads enough.
      const refusal = readInsufficientCreditsRefusal(error);
      if (refusal && typeof refusal.remainingCredits === 'number' && typeof refusal.marketplaceSpendableCredits === 'number') {
        updateCredits(refusal.remainingCredits, { marketplaceSpendableCredits: refusal.marketplaceSpendableCredits });
      }
    },
  });

  // A host that stays mounted across posts (the remix sheet does) shows only
  // the attempt made for the bundle it is showing now.
  const attempt = mutation.variables;
  const ownAttempt = Boolean(target && attempt
    && attempt.postId === target.postId && attempt.resourceId === target.resourceId);
  const attemptError = ownAttempt ? mutation.error : null;
  const refusal = readInsufficientCreditsRefusal(attemptError);

  const priceLabel = !target
    ? null
    : target.accessMode === 'free'
      ? 'Free'
      : typeof target.priceUsdCents === 'number'
        ? formatUnlockCreditPrice(target.priceUsdCents)
        : target.priceLabel ?? null;
  // A refusal names the price when the host could not (the remix sheet, for a
  // feed item that carries no bundle).
  const unlockPrice = target?.priceUsdCents ?? refusal?.creditCost ?? null;
  const shortfall = user && target
    ? getBundleUnlockShortfall(
      { accessMode: target.accessMode, priceUsdCents: unlockPrice },
      getUnlockSpendableCredits(credits, marketplaceSpendableCredits),
    )
    : 0;
  // A refusal its own figures account for is said by the shortfall: they are
  // the balance now (`onError`), and once credits are bought the shortfall
  // goes, and the refusal with it. Any other refusal keeps the server's words
  // and the way to credits.
  const refusalShownAsShortfall = Boolean(refusal
    && typeof refusal.remainingCredits === 'number'
    && typeof refusal.marketplaceSpendableCredits === 'number'
    && unlockPrice !== null
    && refusal.marketplaceSpendableCredits < unlockPrice);

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

  return {
    error: refusalShownAsShortfall ? null : attemptError instanceof Error ? attemptError.message : null,
    goToCredits,
    isPending: ownAttempt && mutation.isPending,
    /** A known shortfall, or the server refusing for want of credits: "Get credits" belongs under the button. */
    offersCredits: shortfall > 0 || (isInsufficientCreditsError(attemptError) && !refusalShownAsShortfall),
    priceLabel,
    request,
    shortfall,
    shortfallMessage: formatBundleUnlockShortfall(shortfall, {
      promotionalCredits: holdsPromotionalCredits(credits, marketplaceSpendableCredits),
    }),
  };
}
