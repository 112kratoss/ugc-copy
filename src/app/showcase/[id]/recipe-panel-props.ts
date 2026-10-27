import { getPostFeedRemixAccess } from '@/lib/post-feed-presentation';
import type { PostRemixCapability, PostRemixTarget } from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import type { ShowcaseMediaItem } from '@/lib/showcase';
import { formatRecipeCreditPrice } from '@/lib/showcase-asset-labels';

import type { PostResourceBundlePanelProps } from './PostResourceBundlePanel';

/**
 * One reading of a post's recipe for every place that draws its panel: the
 * post page, the post once an NSFW reveal brings it (D4, 2026-10-27), and the
 * web reel after an unlock (B-F1), which drew a partial card of its own. Each
 * gets the recipe as `PostResourceBundleDetail` (the post read, the reveal,
 * `GET /api/posts/{id}/resource-bundle`).
 */

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface RecipeRemixOffer {
  /**
   * The post's Remix comes with its recipe (S1): said in the panel before and
   * after buying.
   */
  remixIncluded: boolean;
  /** Remix is locked behind the recipe for this viewer: the row draws it so, with the price. */
  recipeRemix: { access: 'paid' | 'free'; priceLabel: string } | null;
}

/**
 * Whether a post's Remix comes with its recipe, and how the post page offers
 * it to this viewer: open, or locked behind the recipe with its price ("Remix
 * · 900 credits", "Remix · Free"), as the feed's card offers it
 * (`getPostFeedRemixAccess`).
 */
export function getRecipeRemixOffer(post: {
  canRemix: boolean;
  remixCapability?: PostRemixCapability;
  remixTarget?: PostRemixTarget;
  bundle: Pick<PostResourceBundleDetail, 'allowRemix' | 'accessMode' | 'priceUsdCents'> | null;
}): RecipeRemixOffer {
  const remixAccess = getPostFeedRemixAccess({
    asset: post.bundle ? { allowRemix: post.bundle.allowRemix, accessMode: post.bundle.accessMode } : null,
    canRemix: post.canRemix,
    remixCapability: post.remixCapability,
    remixTarget: post.remixTarget,
  });

  return {
    remixIncluded: Boolean(post.bundle?.allowRemix) && remixAccess !== null,
    recipeRemix: post.bundle && remixAccess === 'paid-unlock'
      ? { access: 'paid', priceLabel: formatRecipeCreditPrice(post.bundle.priceUsdCents) }
      : post.bundle && remixAccess === 'free-unlock'
        ? { access: 'free', priceLabel: 'Free' }
        : null,
  };
}

/**
 * What the panel reads of a recipe: all of it the post page has, and all a
 * reel can make up from its answer and the listing beneath it.
 */
export type RecipePanelSource = Pick<
  PostResourceBundleDetail,
  | 'title'
  | 'summary'
  | 'previewText'
  | 'accessMode'
  | 'priceUsdCents'
  | 'viewerCanAccess'
  | 'viewerIsOwner'
  | 'resourceKinds'
  | 'salesCount'
  | 'freeUnlockCount'
  | 'resources'
  | 'purchasedRevision'
> & {
  priceQuote: Pick<PostResourceBundleDetail['priceQuote'], 'formatted' | 'note'>;
  lockedPreview: PostResourceBundleDetail['lockedPreview'] | null;
};

/** The panel's props for a recipe as the server reads it for this viewer. */
export function buildRecipePanelProps(
  bundle: RecipePanelSource,
  options: {
    postId: string;
    mediaItems: ShowcaseMediaItem[];
    /** The post's title as the page shows it: a recipe titled the same is not titled twice. */
    displayTitle?: string;
    remixIncluded: boolean;
    returnPath?: string;
    coverMedia?: boolean;
  },
): PostResourceBundlePanelProps {
  return {
    postId: options.postId,
    mediaItems: options.mediaItems,
    coverMedia: options.coverMedia,
    title: bundle.title,
    suppressTitle: options.displayTitle !== undefined
      && normalizeComparableText(bundle.title) === normalizeComparableText(options.displayTitle),
    summary: bundle.summary,
    previewText: bundle.previewText,
    priceLabel: bundle.priceQuote.formatted,
    priceUsdCents: bundle.priceUsdCents,
    priceNote: bundle.priceQuote.note,
    isFree: bundle.accessMode === 'free',
    viewerCanAccess: bundle.viewerCanAccess,
    viewerIsOwner: bundle.viewerIsOwner,
    resourceKinds: bundle.resourceKinds,
    lockedPreview: bundle.lockedPreview,
    salesCount: bundle.salesCount,
    freeUnlockCount: bundle.freeUnlockCount,
    initialResources: bundle.resources
      ? {
          promptText: bundle.resources.promptText,
          notesMarkdown: bundle.resources.notesMarkdown,
          workflowShareUrl: bundle.resources.workflowShareUrl,
          attachments: bundle.resources.attachments,
          allowRemix: bundle.resources.allowRemix,
          sections: bundle.resources.sections,
          items: bundle.resources.items,
        }
      : null,
    purchasedRevision: bundle.purchasedRevision
      ? {
          revisionNumber: bundle.purchasedRevision.revisionNumber,
          purchasedAt: bundle.purchasedRevision.purchasedAt,
          title: bundle.purchasedRevision.title,
          summary: bundle.purchasedRevision.summary,
          previewText: bundle.purchasedRevision.previewText,
          accessMode: bundle.purchasedRevision.accessMode,
          priceUsdCents: bundle.purchasedRevision.priceUsdCents,
          mediaItems: bundle.purchasedRevision.mediaItems,
          resources: {
            promptText: bundle.purchasedRevision.resources.promptText,
            notesMarkdown: bundle.purchasedRevision.resources.notesMarkdown,
            workflowShareUrl: bundle.purchasedRevision.resources.workflowShareUrl,
            attachments: bundle.purchasedRevision.resources.attachments,
            allowRemix: bundle.purchasedRevision.resources.allowRemix,
            sections: bundle.purchasedRevision.resources.sections,
            items: bundle.purchasedRevision.resources.items,
          },
        }
      : null,
    remixIncluded: options.remixIncluded,
    returnPath: options.returnPath,
  };
}
