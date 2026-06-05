import type {
    MarketplacePriceQuote,
    PostRemixCapability,
    PostRemixTarget,
    PostResourceItemCounts,
    PostResourceBundleLockedPreview,
    PostResourceKind,
} from '@/lib/post-resource-bundles';

export const SHOWCASE_PAGE_SIZE = 12;

export type ShowcaseCategory = 'all' | 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
export type ShowcaseSort = 'recent' | 'top-saves' | 'top-remixes' | 'top-sales';
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

export interface ShowcaseFeedItem {
    id: string;
    mediaUrl: string | null;
    mediaKind: ShowcaseMediaKind | null;
    model: string;
    title: string;
    prompt: string;
    body: string;
    category: ShowcaseItemCategory;
    postFormat: ShowcasePostFormat;
    saveCount: number;
    remixCount: number;
    createdAt: string;
    creator: ShowcaseCreator;
    isSaved?: boolean;
    sourceKind: ShowcaseSourceKind;
    sourceTool: string | null;
    sourceToolSlug?: string | null;
    generationId: string | null;
    asset: ShowcaseAssetSummary | null;
    canRemix: boolean;
    remixCapability?: PostRemixCapability;
    remixTarget?: PostRemixTarget;
}

interface ShowcaseFeedPageInfo {
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
}

export interface ShowcaseFeedPage {
    items: ShowcaseFeedItem[];
    pageInfo: ShowcaseFeedPageInfo;
    availableTools?: Array<{ slug: string; label: string; count: number }>;
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
        sanitized.lockedPreview = asset.lockedPreview;
    }

    if (asset.itemCounts) {
        sanitized.itemCounts = asset.itemCounts;
    }

    return sanitized;
}

export function sanitizeShowcaseFeedPage(feed: ShowcaseFeedPage): ShowcaseFeedPage {
    return {
        ...feed,
        items: feed.items.map((item) => ({
            ...item,
            asset: sanitizeShowcaseAssetSummary(item.asset),
        })),
    };
}

export function normalizeShowcaseCategory(value: string | null | undefined): ShowcaseCategory {
    if (value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad' || value === 'text') {
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
    return value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad' || value === 'text';
}

export function getShowcaseMediaKind(
    category: ShowcaseItemCategory,
    postFormat: ShowcasePostFormat
): ShowcaseMediaKind | null {
    if (postFormat === 'text' || category === 'text') {
        return null;
    }

    return category === 'video' || category === 'motion' ? 'video' : 'image';
}

export function normalizeShowcaseSort(value: string | null | undefined): ShowcaseSort {
    if (value === 'top-saves' || value === 'top-remixes' || value === 'top-sales') {
        return value;
    }

    return 'recent';
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
