import { formatCompactCount, formatRelativeTime } from './home-view-model';
import type { ImmersivePostUnlockDetails, ImmersivePreviewItem } from './immersive-preview-view-model';
import type { MarketplaceResourceDetail, PostResourceBundleResources } from './types';

/**
 * Everything the post details page decides before it draws.
 *
 * The page used to work this out inline: which button leads, what the price
 * pill says, whether the bundle is loading or locked. Pulling it here keeps
 * the component thin and lets each decision be pinned by a test without
 * rendering.
 */

export interface PostDetailsMeta {
  creatorLabel: string;
  /** Relative age of the post, or '' when the source carries no timestamp. */
  timeLabel: string;
  /**
   * Facts that vary from post to post, in reading order: kind, social proof,
   * the tool it was made with. Zeroes are left out — "0 saves" tells the
   * reader nothing a young post isn't already saying.
   */
  metaParts: string[];
}

function countLabel(count: number, singular: string, plural: string) {
  return `${formatCompactCount(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Posts made inside the app record the app as their tool. "Made with
 * Magicbooklet", read inside Magicbooklet, says nothing — only an outside
 * tool is worth naming.
 */
function isOwnTool(label: string) {
  return label.replace(/[\s-]+/g, '').toLowerCase() === 'magicbooklet';
}

export function buildPostDetailsMeta(item: ImmersivePreviewItem, now = new Date()): PostDetailsMeta {
  const details = item.details;
  const parts: string[] = [];

  const category = details?.categoryLabel?.trim();
  if (category) parts.push(category);

  const saveCount = Math.max(0, item.saveCount ?? 0);
  if (saveCount > 0) parts.push(countLabel(saveCount, 'save', 'saves'));

  const remixCount = Math.max(0, details?.remixCount ?? 0);
  if (remixCount > 0) parts.push(countLabel(remixCount, 'remix', 'remixes'));

  const commentCount = Math.max(0, item.commentCount ?? 0);
  if (commentCount > 0) parts.push(countLabel(commentCount, 'comment', 'comments'));

  const toolLabel = details?.toolLabel?.trim();
  if (toolLabel && !isOwnTool(toolLabel)) parts.push(`Made with ${toolLabel}`);

  return {
    creatorLabel: details?.creatorLabel ?? item.creatorLabel,
    timeLabel: item.createdAt ? formatRelativeTime(item.createdAt, now) : '',
    metaParts: parts,
  };
}

export interface PostDetailsPrimaryAction {
  label: 'Remix' | 'Recreate';
}

/**
 * The one orange button on the page.
 *
 * "Remix" is someone else's work made yours — the server endpoint behind it is
 * literally `remixShowcasePost`. "Recreate" is your own creation run again.
 * A locked paid post has no page-level primary: the resources card's unlock
 * button is the purchase path, and two buttons for one purchase is one too many.
 * Once the viewer can access the bundle, a stale `unlock-remix` (the feed has
 * not refetched `canRemix` yet) is treated as a remix — the remix call succeeds
 * after purchase.
 */
export function getDetailsPrimaryAction(
  item: ImmersivePreviewItem,
  options: { canAccess: boolean }
): PostDetailsPrimaryAction | null {
  const actions = new Set(item.availableActions);
  if (actions.has('recreate')) {
    return { label: item.sourceType === 'showcase' ? 'Remix' : 'Recreate' };
  }
  if (actions.has('unlock-remix') && options.canAccess) {
    return { label: 'Remix' };
  }
  return null;
}

export function getUnlockPriceLabel(
  unlock: ImmersivePostUnlockDetails | null,
  bundle: Pick<MarketplaceResourceDetail, 'priceQuote'> | null | undefined
) {
  if (!unlock) return null;
  // A free bundle is "Free" before and after the price quote arrives. The
  // quote formats it as a zero amount, which reads as a glitch, not a gift.
  if (unlock.accessMode === 'free') return 'Free';
  return bundle?.priceQuote?.formatted ?? unlock.priceLabel;
}

export type ResourceSectionState = 'none' | 'loading' | 'error' | 'locked' | 'unlocked';

/**
 * Keyed on the data, not on the query's `isLoading`: the bundle query is only
 * enabled while the page is active, and a disabled query reports
 * `isLoading: false` with no data — which used to render the locked copy and
 * its unlock button for a bundle the viewer might already own.
 */
export function getResourceSectionState(input: {
  hasUnlock: boolean;
  bundle: Pick<MarketplaceResourceDetail, 'viewerCanAccess'> | null | undefined;
  isError: boolean;
}): ResourceSectionState {
  if (!input.hasUnlock) return 'none';
  if (!input.bundle) return input.isError ? 'error' : 'loading';
  return input.bundle.viewerCanAccess ? 'unlocked' : 'locked';
}

export interface PreparedDetailsResources {
  resources: PostResourceBundleResources;
  /** Remix was part of the package; the page says so once, next to the heading. */
  hasRemixAccess: boolean;
  /** Nothing left to list, so the bundle renderer should not mount at all. */
  isEmpty: boolean;
}

function normalizeComparable(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The unlocked bundle as the details page lists it.
 *
 * Remix access is an entitlement, not a document — as a card it was three
 * copies of the words "Remix access" with nothing to tap, so it becomes a
 * pill on the heading and a "Remix" primary button instead. A bundle prompt
 * that repeats the post's own prompt is dropped; the page already printed it.
 */
export function prepareUnlockedResourcesForDetails(
  resources: PostResourceBundleResources,
  options: { detailsPrompt: string }
): PreparedDetailsResources {
  const detailsPrompt = normalizeComparable(options.detailsPrompt);
  const repeatsDetailsPrompt = (text: string | null | undefined) =>
    Boolean(detailsPrompt) && normalizeComparable(text) === detailsPrompt;

  const items = resources.items ?? [];
  const hasRemixAccess = resources.allowRemix || items.some((item) => item.type === 'remix_access');

  if (items.length > 0) {
    const kept = items.filter((item) => {
      if (item.type === 'remix_access') return false;
      if (item.type === 'prompt' && repeatsDetailsPrompt(item.textContent)) return false;
      return true;
    });
    return {
      resources: { ...resources, items: kept, allowRemix: false },
      hasRemixAccess,
      isEmpty: kept.length === 0,
    };
  }

  const promptText = repeatsDetailsPrompt(resources.promptText) ? null : resources.promptText;
  const prepared: PostResourceBundleResources = { ...resources, promptText, allowRemix: false };
  const isEmpty = !promptText
    && !resources.notesMarkdown
    && !resources.workflowShareUrl
    && !resources.workflowSnapshot
    && resources.attachments.length === 0;
  return { resources: prepared, hasRemixAccess, isEmpty };
}

export function getDetailsBackLabel(item: Pick<ImmersivePreviewItem, 'previewKind'>) {
  return item.previewKind === 'text' ? 'Back to post' : 'Back to media';
}

export function getDetailsTitle(item: Pick<ImmersivePreviewItem, 'details'>) {
  return item.details?.generationInfo ? 'Creation details' : 'Details';
}
