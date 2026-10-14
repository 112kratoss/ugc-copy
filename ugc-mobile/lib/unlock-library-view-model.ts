import { formatUnlockCreditPrice } from '@/lib/pricing';
import type { ViewerUnlockDetail, ViewerUnlockItem, ViewerUnlockPayment } from '@/lib/types';

export type UnlockStateBadge = {
  tone: 'kept' | 'updated' | 'none';
  label: string;
} | null;

/**
 * A creator can delist or delete a post after someone unlocked it. Both states
 * are labelled rather than hidden: an unexplained missing item reads as data
 * loss, when in fact the whole point is that the buyer kept it.
 */
export function getUnlockStateBadge(item: ViewerUnlockItem): UnlockStateBadge {
  // Account deletion detaches a purchase without setting either flag below, so
  // the one row that most needed a word had none.
  if (item.detached) {
    return { tone: 'kept', label: 'Creator left' };
  }

  if (item.tombstoned) {
    return { tone: 'kept', label: 'Creator removed the post — yours to keep' };
  }

  if (item.retired) {
    return { tone: 'kept', label: 'No longer sold — yours to keep' };
  }

  if (item.hasNewerRevision) {
    return { tone: 'updated', label: 'Creator added an update' };
  }

  return null;
}

export function formatUnlockPrice(priceUsdCents: number): string {
  // "credits", not "tokens": this is a buyer-facing surface, and the buyer
  // spent credits — the unlock runs through `unlockBundleWithCredits` and
  // decrements the credit balance. The list previously said "900 tokens" for
  // an item the detail screen one tap away called "900 credits paid", which
  // read as two different currencies. Seller-side pricing copy still says
  // tokens; sellers are paid in USD, so that split is left alone. The dollar
  // figure that used to follow in brackets is gone too: see
  // `formatUnlockCreditPrice`.
  return formatUnlockCreditPrice(priceUsdCents);
}

type UnlockPayment = Pick<ViewerUnlockItem, 'purchasePriceUsdCents'> & Partial<ViewerUnlockPayment>;

type PaidAmount =
  | { kind: 'free' }
  | { kind: 'credits'; credits: string }
  | { kind: 'cash'; receipt: string };

function readUnlockPayment(payment: UnlockPayment): PaidAmount {
  if (payment.paidWith === 'free') return { kind: 'free' };
  if (payment.paidWith === 'cash') {
    return { kind: 'cash', receipt: formatCashReceipt(payment.paidAmountSubunits ?? null, payment.paidCurrency ?? null) };
  }
  // A server that sends no payment yet: the purchase price, one credit per cent.
  const credits = payment.paidWith === 'credits'
    ? payment.paidAmountSubunits ?? payment.purchasePriceUsdCents
    : payment.purchasePriceUsdCents;
  return credits > 0 ? { kind: 'credits', credits: formatUnlockCreditPrice(credits) } : { kind: 'free' };
}

/** A web purchase's amount in its own currency: "₹750 paid", "$9.00 paid". */
function formatCashReceipt(amountSubunits: number | null, currency: string | null): string {
  if (amountSubunits === null || !Number.isFinite(amountSubunits) || amountSubunits < 0 || !currency) return 'Paid';
  const code = currency.toUpperCase();
  const amount = amountSubunits / 100;
  // Rupees as the web writes them (`formatMoney`): no paise when there are none.
  const fractionDigits = code === 'INR' && Number.isInteger(amount) ? 0 : 2;
  try {
    const formatted = new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount);
    return `${formatted} paid`;
  } catch {
    return `${amount.toFixed(2)} ${code} paid`;
  }
}

/**
 * What the buyer paid, as a library row says it: "900 credits", "₹750 paid" or
 * "Free". A cash amount is only ever a receipt for a purchase paid in cash on
 * the web; every price an unlock is offered at stays in credits
 * (`formatUnlockPrice`, App Review 2.1(b)).
 */
export function formatUnlockPaid(payment: UnlockPayment): string {
  const paid = readUnlockPayment(payment);
  if (paid.kind === 'free') return 'Free';
  return paid.kind === 'cash' ? paid.receipt : paid.credits;
}

/** The same purchase on the detail's pill: "900 credits paid", "₹750 paid", "Free unlock". */
export function formatUnlockPaidPill(payment: UnlockPayment): string {
  const paid = readUnlockPayment(payment);
  if (paid.kind === 'free') return 'Free unlock';
  return paid.kind === 'cash' ? paid.receipt : `${paid.credits} paid`;
}

export function formatUnlockDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Opens the unlock, not the feed.
 *
 * The immersive viewer reads `initialId` and normalizes any unrecognised
 * `source` back to the showcase feed, so a `?postId=…&source=unlocks` link
 * silently dropped every buyer into the generic feed. The unlock screen is the
 * right destination anyway: it reads the purchase itself
 * (`GET /api/me/unlocks/:id`), so it still opens for a delisted or deleted post.
 */
export function getUnlockDestination(item: ViewerUnlockItem): string {
  return `/unlock/${encodeURIComponent(item.unlockId)}`;
}

/**
 * The still a library row draws: the purchase's preview, else the original
 * when it is a picture. Never a video's own file: expo-image cannot draw an
 * MP4 (on Android Glide takes no frame from one), so a video without a poster
 * keeps the placeholder icon.
 */
export function getUnlockThumbnailUrl(item: Pick<ViewerUnlockItem, 'post'>): string | null {
  const post = item.post;
  if (!post) return null;
  return post.previewUrl ?? (post.mediaKind === 'image' ? post.mediaUrl : null) ?? null;
}

export type UnlockCover =
  | { kind: 'none' }
  | { kind: 'image'; stillUrl: string }
  | { kind: 'video'; stillUrl: string | null; videoUrl: string };

/**
 * The detail's cover: a still for a picture or a video, with the clip itself
 * behind a tap, so opening an unlock no longer downloads a whole video.
 */
export function getUnlockCover(post: ViewerUnlockDetail['post']): UnlockCover {
  if (!post) return { kind: 'none' };
  const still = post.mediaPreviewUrl ?? null;
  if (post.mediaKind === 'video') {
    if (post.mediaUrl) return { kind: 'video', stillUrl: still, videoUrl: post.mediaUrl };
    return still ? { kind: 'image', stillUrl: still } : { kind: 'none' };
  }
  const stillUrl = still ?? post.mediaUrl;
  return stillUrl ? { kind: 'image', stillUrl } : { kind: 'none' };
}

/**
 * Whether "View original post" leads anywhere: the server's `postReachable`
 * (public or unlisted, live, and no block either way). The post read drops a
 * blocked creator's posts, so a buyer on either side of a block was sent on to
 * "This post isn't available".
 */
export function canOpenUnlockedPost(
  detail: Pick<ViewerUnlockDetail, 'postId' | 'post' | 'detached' | 'postReachable'>
): boolean {
  return Boolean(detail.postId && detail.post && !detail.detached && detail.postReachable);
}

/**
 * Why there is no way on to the post. A private or archived post says so; a
 * post that is still listed is out of reach for a reason the buyer is not told
 * (a block either way), so it gets the neutral line.
 */
export function describeUnreachableUnlockedPost(detail: Pick<ViewerUnlockDetail, 'post' | 'postVisibility'>): string {
  const visibility = detail.post?.visibility ?? detail.postVisibility;
  const listed = (visibility === 'public' || visibility === 'unlisted') && !detail.post?.archivedAt;
  return listed
    ? "This post isn't available to you. Your unlock stays here."
    : 'This post is no longer public. Your unlock stays available here.';
}

export function summarizeUnlockCount(total: number): string {
  return `${total} ${total === 1 ? 'unlock' : 'unlocks'} · yours permanently`;
}
