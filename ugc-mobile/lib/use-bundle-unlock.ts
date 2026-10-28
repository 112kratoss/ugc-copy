import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';

import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import { showConfirmDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { formatCreditAmount, formatUnlockCreditPrice } from '@/lib/pricing';
import { announceRecipeUnlocked } from '@/lib/recipe-unlocked-notice';
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
export const PROMOTIONAL_CREDITS_NOTE = "Welcome and referral credits can't be spent on recipes.";

const INSUFFICIENT_CREDITS_CODE: InsufficientCreditsResponse['code'] = 'INSUFFICIENT_CREDITS';

/**
 * The credit unlock's 409 when the price is no longer the one the buyer
 * confirmed: nothing is charged, and the body names the price now
 * (`priceCredits`). Sent only to a request that said which price it confirmed.
 */
const RESOURCE_PRICE_CHANGED_CODE = 'RESOURCE_PRICE_CHANGED';

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
  const amount = Math.trunc(shortfall);
  const message = `You need ${formatCreditAmount(amount)} more ${amount === 1 ? 'credit' : 'credits'}.`;
  return promotionalCredits ? `${message} ${PROMOTIONAL_CREDITS_NOTE}` : message;
}

/**
 * The confirm for a paid unlock, in the glossary's words on every host. Asked
 * again after the price moved under the buyer, the change leads.
 */
export function describePaidUnlockConfirmation(priceLabel: string | null, { priceChanged = false }: { priceChanged?: boolean } = {}) {
  const cost = `${priceLabel ?? 'The price'} will come off your balance.`;
  return {
    title: 'Unlock this recipe?',
    message: priceChanged && priceLabel ? `The price changed to ${priceLabel}. ${cost}` : cost,
    confirmLabel: priceLabel ? `Unlock for ${priceLabel}` : 'Unlock with credits',
  };
}

/** "The price changed to 1,200 credits.", or, for a recipe that became free, that. */
export function formatPriceChange(priceCredits: number) {
  return priceCredits > 0
    ? `The price changed to ${formatUnlockCreditPrice(priceCredits)}.`
    : 'This recipe is free now.';
}

/** The price the credit unlock refused on because it was not the confirmed one; null for any other failure. */
export function readPriceChangedRefusal(error: unknown): { priceCredits: number } | null {
  if (!error || typeof error !== 'object') return null;
  const { code, details } = error as { code?: unknown; details?: unknown };
  const body = details && typeof details === 'object' ? details as Record<string, unknown> : null;
  if (code !== RESOURCE_PRICE_CHANGED_CODE && body?.code !== RESOURCE_PRICE_CHANGED_CODE) return null;
  const price = body?.priceCredits;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  return { priceCredits: Math.trunc(price) };
}

/**
 * The price the server answered with, for the bundle it was asked about, kept
 * until the host's own read of the bundle catches up: it applies while the
 * host still says the price it said when the unlock was refused (`hostPrice`).
 */
type PriceChange = { postId: string; resourceId: string; hostPrice: number | null; priceCredits: number };

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
 * - A paid unlock sends the price the buyer confirmed. When the creator has
 *   repriced since, the server charges nothing and names the new price: the
 *   hook says so, shows that price, has the host read the recipe again, and
 *   asks once more at the new price (unless the balance no longer covers it).
 * - Every unlock ends on "Recipe unlocked", with the way to Unlocked recipes
 *   (`lib/recipe-unlocked-notice.ts`), wherever it was made.
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
  const [priceChange, setPriceChange] = useState<PriceChange | null>(null);

  // The price the server last answered with stands in for the host's until the
  // host reads the bundle again; after that the host's own read wins.
  const changedPrice = target && priceChange
    && priceChange.postId === target.postId
    && priceChange.resourceId === target.resourceId
    && priceChange.hostPrice === target.priceUsdCents
    ? priceChange.priceCredits
    : null;
  const current: BundleUnlockTarget | null = target && changedPrice !== null
    ? { ...target, priceUsdCents: changedPrice }
    : target;

  const ask = (unlock: BundleUnlockTarget, { priceChanged = false }: { priceChanged?: boolean } = {}) => {
    // A paid unlock spends the balance at once and cannot be undone.
    const label = typeof unlock.priceUsdCents === 'number'
      ? formatUnlockCreditPrice(unlock.priceUsdCents)
      : unlock.priceLabel ?? null;
    const { title, message, confirmLabel } = describePaidUnlockConfirmation(label, { priceChanged });
    if (confirmWith === 'dialog') {
      void showConfirmDialog({ title, message, confirmLabel }).then((confirmed) => {
        if (confirmed) mutation.mutate(unlock);
      });
      return;
    }
    showActionSheet({ title, message, actions: [{ label: confirmLabel, onPress: () => mutation.mutate(unlock) }] });
  };

  const mutation = useMutation({
    mutationFn: (unlock: BundleUnlockTarget): Promise<BundleUnlockResult> => (
      unlock.accessMode === 'free'
        ? api.unlockFreeBundle(unlock.postId)
        // The price the buyer was shown and confirmed; an unknown one is not
        // sent, and the server then charges the price it holds, as before.
        : api.unlockBundleWithCredits(unlock.postId, typeof unlock.priceUsdCents === 'number' ? unlock.priceUsdCents : undefined)
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
      // Before the host's own next step: the remix sheet goes on to the
      // editor, and the notice is drawn above it.
      announceRecipeUnlocked();
      await onUnlocked?.(result, unlock);
    },
    onError: (error, unlock) => {
      // The app asked because the balance it held covered the price, or
      // because it held none. The server's count becomes the balance, so every
      // surface shows the shortfall it refused on, not a balance that still
      // reads enough.
      const refusal = readInsufficientCreditsRefusal(error);
      if (refusal && typeof refusal.remainingCredits === 'number' && typeof refusal.marketplaceSpendableCredits === 'number') {
        updateCredits(refusal.remainingCredits, { marketplaceSpendableCredits: refusal.marketplaceSpendableCredits });
      }

      const moved = readPriceChangedRefusal(error);
      if (!moved) return;
      const sameBundle = Boolean(target && target.postId === unlock.postId && target.resourceId === unlock.resourceId);
      setPriceChange({
        postId: unlock.postId,
        resourceId: unlock.resourceId,
        hostPrice: sameBundle && target ? target.priceUsdCents : unlock.priceUsdCents,
        priceCredits: moved.priceCredits,
      });
      // The hosts' reads of the bundle, so the card shows what it sells for now.
      for (const queryKey of [['post-resource-bundle', unlock.postId, unlock.resourceId], ['marketplace-resource', unlock.resourceId]]) {
        void Promise.resolve(queryClient.invalidateQueries({ queryKey })).catch(() => undefined);
      }
      const repriced: BundleUnlockTarget = { ...unlock, priceUsdCents: moved.priceCredits };
      const spendable = getUnlockSpendableCredits(credits, marketplaceSpendableCredits);
      // Asked again only where the buyer can still pay: past the balance, the
      // shortfall and the way to credits say so instead.
      if (moved.priceCredits > 0 && getBundleUnlockShortfall(repriced, spendable) === 0) {
        ask(repriced, { priceChanged: true });
      }
    },
  });

  // A host that stays mounted across posts (the remix sheet does) shows only
  // the attempt made for the bundle it is showing now.
  const attempt = mutation.variables;
  const ownAttempt = Boolean(current && attempt
    && attempt.postId === current.postId && attempt.resourceId === current.resourceId);
  const attemptError = ownAttempt ? mutation.error : null;
  const refusal = readInsufficientCreditsRefusal(attemptError);
  const priceMoved = readPriceChangedRefusal(attemptError);

  const priceLabel = !current
    ? null
    : current.accessMode === 'free'
      ? 'Free'
      : typeof current.priceUsdCents === 'number'
        ? formatUnlockCreditPrice(current.priceUsdCents)
        : current.priceLabel ?? null;
  // A refusal names the price when the host could not (the remix sheet, for a
  // feed item that carries no bundle).
  const unlockPrice = current?.priceUsdCents ?? refusal?.creditCost ?? null;
  const shortfall = user && current
    ? getBundleUnlockShortfall(
      { accessMode: current.accessMode, priceUsdCents: unlockPrice },
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
    if (!current || mutation.isPending) return;
    if (current.accessMode === 'free') {
      mutation.mutate(current);
      return;
    }
    if (shortfall > 0) return;
    ask(current);
  };

  return {
    error: priceMoved
      ? formatPriceChange(priceMoved.priceCredits)
      : refusalShownAsShortfall ? null : attemptError instanceof Error ? attemptError.message : null,
    goToCredits,
    isPending: ownAttempt && mutation.isPending,
    /** A known shortfall, or the server refusing for want of credits: "Get credits" belongs under the button. */
    offersCredits: shortfall > 0 || (isInsufficientCreditsError(attemptError) && !refusalShownAsShortfall),
    /** The last attempt was refused because the price moved; `error` says to what. */
    priceChanged: Boolean(priceMoved),
    priceLabel,
    request,
    shortfall,
    shortfallMessage: formatBundleUnlockShortfall(shortfall, {
      promotionalCredits: holdsPromotionalCredits(credits, marketplaceSpendableCredits),
    }),
  };
}
