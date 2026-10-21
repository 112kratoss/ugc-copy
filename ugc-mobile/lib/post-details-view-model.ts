import { homeModelLabel } from './home-feed-view-model';
import { formatCompactCount, formatRelativeTime } from './home-view-model';
import { formatCreditAmount, formatUnlockCreditPrice } from './pricing';
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

/** "3 comments", as the line under the title says it and the Comments button tells a screen reader. */
export function commentCountLabel(count: number): string {
  return countLabel(count, 'comment', 'comments');
}

/**
 * Posts made inside the app record the app as their tool. "Made with
 * Magicbooklet", read inside Magicbooklet, says nothing — only an outside
 * tool is worth naming.
 */
function isOwnTool(label: string) {
  return label.replace(/[\s-]+/g, '').toLowerCase() === 'magicbooklet';
}

/**
 * `commentsOnButton`: the page draws a Comments button, which carries the count ("3"), so the
 * line leaves it out rather than say it twice.
 */
export function buildPostDetailsMeta(
  item: ImmersivePreviewItem,
  now = new Date(),
  { commentsOnButton = false }: { commentsOnButton?: boolean } = {},
): PostDetailsMeta {
  const details = item.details;
  const parts: string[] = [];

  const category = details?.categoryLabel?.trim();
  if (category) parts.push(category);

  const saveCount = Math.max(0, item.saveCount ?? 0);
  if (saveCount > 0) parts.push(countLabel(saveCount, 'save', 'saves'));

  const remixCount = Math.max(0, details?.remixCount ?? 0);
  if (remixCount > 0) parts.push(countLabel(remixCount, 'remix', 'remixes'));

  const commentCount = Math.max(0, item.commentCount ?? 0);
  if (commentCount > 0 && !commentsOnButton) parts.push(commentCountLabel(commentCount));

  // The model by the feed card's rule (`homeModelLabel`, decision 13,
  // 2026-10-17): its display name, never a slug, and none for a text post or
  // a model the catalog does not name. Without one, an outside tool the
  // creator named keeps the line, as on the web's post page.
  const modelLabel = item.previewKind === 'text' ? null : homeModelLabel(details?.model);
  const toolLabel = details?.toolLabel?.trim();
  if (modelLabel) parts.push(`Made with ${modelLabel}`);
  else if (toolLabel && !isOwnTool(toolLabel)) parts.push(`Made with ${toolLabel}`);

  return {
    creatorLabel: details?.creatorLabel ?? item.creatorLabel,
    timeLabel: item.createdAt ? formatRelativeTime(item.createdAt, now) : '',
    metaParts: parts,
  };
}

export interface PostDetailsStat {
  label: string;
  value: string;
}

function creditCount(amount: number) {
  return `${formatCreditAmount(amount)} ${amount === 1 ? 'credit' : 'credits'}`;
}

/**
 * What a failed run gave back, in the web Studio's words: "40 credits
 * returned". Null unless its settlement returned a charge; a failed run that
 * kept its cost, or cost nothing, says so through its cost instead.
 */
export function formatReturnedCredits(
  info: { cost?: number | null; refunded?: boolean } | null | undefined
): string | null {
  const cost = info?.cost ?? 0;
  if (!info?.refunded || cost <= 0) return null;
  return `${creditCount(cost)} returned`;
}

/**
 * The production facts of a creation, one tile each.
 *
 * The page used to show exactly two tiles — the model, then the duration *or*
 * the cost — so a video, which always has a duration, never said what it had
 * cost, and the cost an image did show was a bare number that Studio spells
 * "285 credits" three screens away. Every fact that exists now gets its own
 * tile, in the same words the rest of the app uses; a zero is left out, the
 * way `buildPostDetailsMeta` leaves out "0 saves".
 */
export function buildGenerationStats(
  info: {
    model?: string | null;
    duration?: number | null;
    cost?: number | null;
    refunded?: boolean;
    outputCount?: number | null;
  } | null | undefined
): PostDetailsStat[] {
  if (!info) return [];
  const stats: PostDetailsStat[] = [];

  const model = info.model?.trim();
  if (model) stats.push({ label: 'Model', value: model });

  const duration = info.duration ?? 0;
  if (duration > 0) stats.push({ label: 'Duration', value: `${duration}s` });

  // The slide shows one file of a run that made several; the web Studio says
  // how many, and the outputs row under these tiles opens the rest.
  const outputCount = info.outputCount ?? 0;
  if (outputCount > 1) stats.push({ label: 'Outputs', value: String(outputCount) });

  // A refunded run keeps its `cost` on the row, and "Cost: 40 credits" read as
  // a charge for a run that cost nothing. Its tile says what came back instead.
  const cost = info.cost ?? 0;
  if (cost > 0) {
    stats.push(formatReturnedCredits(info)
      ? { label: 'Returned', value: creditCount(cost) }
      : { label: 'Cost', value: creditCount(cost) });
  }

  return stats;
}

export interface PostDetailsPrimaryAction {
  label: 'Remix' | 'Recreate' | 'Try again';
}

/**
 * The one orange button on the page.
 *
 * "Remix" is someone else's work made yours — the server endpoint behind it is
 * literally `remixShowcasePost`. "Recreate" is your own creation run again.
 * A post whose remix sits behind a free unlock keeps the button: it arrives
 * with `recreate`, and the tap claims the unlock on its way to the editor.
 * A locked paid post has no page-level primary: the resources card's unlock
 * button is the purchase path, and two buttons for one purchase is one too many.
 * Once the viewer can access the bundle, a stale `unlock-remix` (the feed has
 * not refetched `canRemix` yet) is treated as a remix — the remix call succeeds
 * after purchase. A failed run's is "Try again", as the web's Failed card and
 * the ••• call it.
 */
export function getDetailsPrimaryAction(
  item: ImmersivePreviewItem,
  options: { canAccess: boolean }
): PostDetailsPrimaryAction | null {
  const actions = new Set(item.availableActions);
  if (actions.has('recreate')) {
    if (item.sourceType === 'showcase') return { label: 'Remix' };
    return { label: item.runStatus === 'failed' ? 'Try again' : 'Recreate' };
  }
  if (actions.has('unlock-remix') && options.canAccess) {
    return { label: 'Remix' };
  }
  return null;
}

export function getUnlockPriceLabel(
  unlock: ImmersivePostUnlockDetails | null,
  bundle: Pick<MarketplaceResourceDetail, 'priceUsdCents'> | null | undefined
) {
  if (!unlock) return null;
  // A free bundle is "Free" before and after the bundle's own record arrives.
  if (unlock.accessMode === 'free') return 'Free';
  // The loaded record wins, since a creator can reprice after the feed was
  // read. It is shown in credits, as the unlock is paid, and never as the cash
  // `priceQuote` the web checkout uses.
  return typeof bundle?.priceUsdCents === 'number'
    ? formatUnlockCreditPrice(bundle.priceUsdCents)
    : unlock.priceLabel;
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

/**
 * The section a link asks the Details page to lead with: a card's Read more
 * opens the part holding the text it previewed, and a recipe found in search
 * opens on the creator's resources, as the web search opens the post at
 * `#recipe`.
 */
export type PostDetailsSection = 'story' | 'prompt' | 'resources';

/** A route param read as a section; anything the page has no section for opens it as usual. */
export function readPostDetailsSection(value: string | null | undefined): PostDetailsSection | undefined {
  return value === 'story' || value === 'prompt' || value === 'resources' ? value : undefined;
}

export function getDetailsBackLabel(item: Pick<ImmersivePreviewItem, 'previewKind'>) {
  if (item.previewKind === 'audio') return 'Back to audio';
  return item.previewKind === 'text' ? 'Back to post' : 'Back to media';
}

export function getDetailsTitle(item: Pick<ImmersivePreviewItem, 'details'>) {
  return item.details?.generationInfo ? 'Creation details' : 'Details';
}
