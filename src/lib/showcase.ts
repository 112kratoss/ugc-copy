import {
    sanitizePostResourceBundleLockedPreview,
    type MarketplacePriceQuote,
    type PostRemixCapability,
    type PostRemixTarget,
    type PostResourceItemCounts,
    type PostResourceBundleLockedPreview,
    type PostResourceKind,
} from '@/lib/post-resource-bundles';
import type { VisualMediaDescriptor } from '@/lib/media-descriptor';
import { sanitizePublicPostContent } from '@/lib/post-public-content';

export const SHOWCASE_PAGE_SIZE = 12;
// A full page in the bootstrap keeps the grid from sitting near-empty while
// the client fills in. It matches SHOWCASE_PAGE_SIZE so every anonymous
// surface shares one cached feed entry, but stays a separate knob in case the
// bootstrap payload ever needs to shrink again.
export const SHOWCASE_INITIAL_PAGE_SIZE = 12;
// How many cards the pre-activation bootstrap shell paints, and therefore how
// many the interactive client must already show when it takes over — dropping
// back to one and ticking up would read as the grid emptying itself. Six fills
// a desktop row and a half without hydrating the whole page at once. The shell
// fetches only the priority poster; the remaining cards reserve stable space
// until the interactive client takes over.
export const SHOWCASE_INITIAL_RENDER_COUNT = 6;

export interface ShowcasePriorityPosterData {
    postId: string;
    mediaId: string;
    dataUrl: string;
}

export type ShowcaseCategory = 'all' | 'image' | 'video' | 'text';
export type ShowcaseSort = 'for-you' | 'recent' | 'top-saves' | 'top-remixes' | 'top-sales';
export type ShowcaseUnlockFilter = 'all' | 'with-unlock' | 'free' | 'paid';
export type ShowcaseResourceFilter = 'all' | 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';
export type ShowcaseItemCategory = Exclude<ShowcaseCategory, 'all'>;
export const MAGICBOOKLET_SOURCE_KIND = 'magicbooklet' as const;
const LEGACY_EMPTYBOOKLET_SOURCE_KIND = 'emptybooklet' as const;
const LEGACY_UGC_COPY_SOURCE_KIND = 'ugc_copy' as const;
export type ShowcaseSourceKind = typeof MAGICBOOKLET_SOURCE_KIND | 'external' | 'manual';
export type RawShowcaseSourceKind =
    ShowcaseSourceKind
    | typeof LEGACY_EMPTYBOOKLET_SOURCE_KIND
    | typeof LEGACY_UGC_COPY_SOURCE_KIND;
export type ShowcaseVisibility = 'public' | 'unlisted' | 'private';
export type ShowcasePostFormat = 'text' | 'media' | 'mixed';
export type ShowcaseMediaKind = 'image' | 'video';
export type ShowcaseAssetType = 'workflow' | 'prompt_pack' | 'guide';
type ShowcaseResourceAccessMode = 'free' | 'paid';
export const GENERATION_RECIPE_ASSET_ID_PREFIX = 'generation-recipe:';

export interface ShowcaseCreator {
    id: string | null;
    username: string | null;
    name: string;
    avatar: string | null;
}

export interface ShowcaseAssetSummary {
    id: string;
    postId: string;
    title: string;
    accessMode: ShowcaseResourceAccessMode;
    priceUsdCents: number;
    priceQuote?: MarketplacePriceQuote;
    previewText: string;
    allowRemix: boolean;
    salesCount?: number;
    resourceKinds?: PostResourceKind[];
    lockedPreview?: PostResourceBundleLockedPreview;
    itemCounts?: PostResourceItemCounts;
}

export interface ShowcaseMediaItem {
    id: string;
    /** Stable across edits/reordering; legacy clients may omit it during rollout. */
    mediaKey?: string;
    url: string;
    /**
     * Small faststart copy, streamed by every surface that plays the clip.
     * Absent until the rendition pipeline has produced one, so clients must
     * fall back to `url` — which also stays what downloads and remixes use.
     */
    renditionUrl?: string | null;
    previewUrl?: string | null;
    previewThumbhash?: string | null;
    previewStatus?: 'pending' | 'processing' | 'ready' | 'failed';
    previewCacheKey?: string;
    gridReady?: boolean;
    preview?: VisualMediaDescriptor;
    mediaKind: ShowcaseMediaKind;
    contentType: string | null;
    originalName: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    sortOrder: number;
}

export interface ShowcaseFeedItem {
    id: string;
    mediaUrl: string | null;
    mediaKind: ShowcaseMediaKind | null;
    mediaItems?: ShowcaseMediaItem[];
    model: string;
    title: string;
    prompt: string;
    body: string;
    category: ShowcaseItemCategory;
    creationMode?: 'motion' | null;
    postFormat: ShowcasePostFormat;
    saveCount: number;
    remixCount: number;
    commentCount: number;
    createdAt: string;
    creator: ShowcaseCreator;
    isSaved?: boolean;
    sourceKind: ShowcaseSourceKind;
    sourceTool: string | null;
    sourceToolSlug?: string | null;
    sourceTools?: Array<{
      toolLabel: string;
      toolSlug?: string | null;
      modelLabel?: string | null;
      modelSlug?: string | null;
    }>;
    generationId: string | null;
    asset: ShowcaseAssetSummary | null;
    canRemix: boolean;
    remixCapability?: PostRemixCapability;
    remixTarget?: PostRemixTarget;
    savedAt?: string;
    recommendation?: ShowcaseRecommendationContext;
}

interface ShowcaseFeedPageInfo {
    hasMore: boolean;
    nextOffset: number | null;
    nextCursor?: string | null;
    limit: number;
    offset: number;
}

export interface ShowcaseFeedPage {
    items: ShowcaseFeedItem[];
    pageInfo: ShowcaseFeedPageInfo;
    availableTools?: Array<{ slug: string; label: string; count: number }>;
    feedSessionId?: string | null;
    algorithmVersion?: string;
}

export type ShowcaseFeedCandidateSource =
    | 'affinity'
    | 'following'
    | 'fresh'
    | 'trending'
    | 'exploration'
    | 'semantic';

export interface ShowcaseRecommendationContext {
    deliveryId: string;
    position: number;
    reason: string;
    algorithmVersion: string;
    candidateSource?: ShowcaseFeedCandidateSource;
}

export type ShowcaseFeedEventType =
    | 'impression'
    | 'open'
    | 'dwell'
    | 'media_progress'
    | 'quick_skip'
    | 'save'
    | 'unsave'
    | 'share'
    | 'follow'
    | 'remix_start'
    | 'remix_complete'
    | 'resource_open'
    | 'purchase'
    | 'not_interested'
    | 'hide_creator'
    | 'report';

export function isGenerationRecipeAssetId(value: string | null | undefined): boolean {
    return Boolean(value?.startsWith(GENERATION_RECIPE_ASSET_ID_PREFIX));
}

export function sanitizeShowcaseAssetSummary(
    asset: ShowcaseAssetSummary | null | undefined
): ShowcaseAssetSummary | null {
    if (!asset) {
        return null;
    }

    const sanitized: ShowcaseAssetSummary = {
        id: asset.id,
        postId: asset.postId,
        title: asset.title,
        accessMode: asset.accessMode,
        priceUsdCents: asset.priceUsdCents,
        previewText: asset.previewText,
        allowRemix: asset.allowRemix,
    };

    if (asset.priceQuote) {
        sanitized.priceQuote = asset.priceQuote;
    }

    if (typeof asset.salesCount === 'number') {
        sanitized.salesCount = asset.salesCount;
    }

    if (asset.resourceKinds) {
        sanitized.resourceKinds = asset.resourceKinds;
    }

    if (asset.lockedPreview) {
        sanitized.lockedPreview = sanitizePostResourceBundleLockedPreview(asset.lockedPreview);
    }

    if (asset.itemCounts) {
        sanitized.itemCounts = asset.itemCounts;
    }

    return sanitized;
}

/**
 * Strips locked bundle metadata and paid recipe text from a single feed item.
 * Every public surface that serves posts must map its items through this —
 * the showcase feed and creator profiles both do. Sanitizing returns fresh
 * objects, so callers may localize prices on the result without mutating rows
 * shared with a cache.
 */
export function sanitizeShowcaseFeedItem(item: ShowcaseFeedItem): ShowcaseFeedItem {
    const asset = sanitizeShowcaseAssetSummary(item.asset);
    const publicContent = sanitizePublicPostContent({
        prompt: item.prompt,
        body: item.body,
        description: '',
        hasRecipe: Boolean(asset),
        isPaidRecipe: asset?.accessMode === 'paid',
    });

    return {
        ...item,
        prompt: publicContent.prompt,
        body: publicContent.body,
        asset,
    };
}

export function sanitizeShowcaseFeedPage(feed: ShowcaseFeedPage): ShowcaseFeedPage {
    return {
        ...feed,
        items: feed.items.map(sanitizeShowcaseFeedItem),
    };
}

export function normalizeShowcaseCategory(value: string | null | undefined): ShowcaseCategory {
    if (value === 'motion' || value === 'ugc-ad') return 'video';
    if (value === 'image' || value === 'video' || value === 'text') {
        return value;
    }

    return 'all';
}

export function normalizeShowcaseSourceKind(value: string | null | undefined): ShowcaseSourceKind {
    if (
        value === MAGICBOOKLET_SOURCE_KIND
        || value === LEGACY_EMPTYBOOKLET_SOURCE_KIND
        || value === LEGACY_UGC_COPY_SOURCE_KIND
    ) {
        return MAGICBOOKLET_SOURCE_KIND;
    }

    if (value === 'external' || value === 'manual') {
        return value;
    }

    return 'external';
}

export function isShowcaseItemCategory(value: string | null | undefined): value is ShowcaseItemCategory {
    return value === 'image' || value === 'video' || value === 'text';
}

export function getShowcaseMediaKind(
    category: ShowcaseItemCategory,
    postFormat: ShowcasePostFormat
): ShowcaseMediaKind | null {
    if (postFormat === 'text' || category === 'text') {
        return null;
    }

    return category === 'video' ? 'video' : 'image';
}

export function normalizeShowcaseSort(value: string | null | undefined): ShowcaseSort {
    if (
        value === 'recent'
        || value === 'top-saves'
        || value === 'top-remixes'
        || value === 'top-sales'
    ) {
        return value;
    }

    return 'for-you';
}

export function normalizeShowcaseUnlockFilter(value: string | null | undefined): ShowcaseUnlockFilter {
    if (value === 'with-unlock' || value === 'free' || value === 'paid') {
        return value;
    }

    return 'all';
}

export function normalizeShowcaseResourceFilter(value: string | null | undefined): ShowcaseResourceFilter {
    if (value === 'prompt' || value === 'workflow' || value === 'files' || value === 'notes' || value === 'remix') {
        return value;
    }

    return 'all';
}

export function parsePositiveInt(value: string | null | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
}

export function normalizeShowcaseOffset(
    offsetValue: string | null | undefined,
    pageValue: string | null | undefined,
    limit: number
): number {
    if (offsetValue) {
        return parsePositiveInt(offsetValue, 0);
    }

    if (!pageValue) {
        return 0;
    }

    const page = Math.max(1, parsePositiveInt(pageValue, 1));
    return (page - 1) * limit;
}
